window.__ModuleLoader__.load({
  id: 'dsh-session-edit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const {
      useCallback, useEffect, useRef, useState,
    } = React;

    const NS = 'dsh-session-edit';
    const CHANNEL = '/session-edit';
    const ENDPOINT = /^[A-Za-z0-9_$.-]+$/;

    /** Context kind the Conversation engine gives one user message. */
    const USER_CONTEXT_KIND = 'input-message';

    // All visible copy lives in `locale/*.json`, which the package registers
    // before this factory runs; `ctx.locale.bind(NS)` reads it.
    // The Client half owns the visible copy: `locale/*.json` only carries the
    // plugin metadata the Host reads at boot, so this is the single dictionary
    // source and it is registered once inside `apply` with a disposer.
    const EN = {
      edit: 'Edit and resend', title: 'Edit this message', close: 'Close',
      warning: 'Later conversation will be removed from the active context. Existing file changes and other external effects are not undone.',
      label: 'Message text', submit: 'Send', cancel: 'Cancel', loading: 'Reading the message…',
      saving: 'Sending…', retry: 'Try again', failed: 'Could not complete the action:',
      empty: 'Enter a message.', invalid: 'The host returned an unexpected response.',
      unavailable: 'This window is not connected to the host.',
      'refusal.UNKNOWN_MESSAGE': 'That message is no longer in the active context.',
    };
    const ZH = {
      edit: '编辑并重新发送', title: '编辑这条消息', close: '关闭',
      warning: '后续对话将从有效上下文中移除。已发生的文件修改和其他外部操作不会回滚。',
      label: '消息内容', submit: '发送', cancel: '取消', loading: '正在读取消息…',
      saving: '正在发送…', retry: '重试', failed: '操作未能完成：',
      empty: '请输入消息内容。', invalid: '主机返回了无法识别的响应。',
      unavailable: '当前窗口未连接到主机。',
      'refusal.UNKNOWN_MESSAGE': '这条消息已不在有效上下文中。',
    };

    /** Minimal external store shared by every message row and the overlay dialog. */
    function createStore() {
      let state = { open: false, sessionId: '', messageId: '' };
      const listeners = new Set();
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(next) {
          state = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    const uuid = () => {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      const view = new DataView(bytes.buffer);
      view.setUint8(6, (view.getUint8(6) & 15) | 64);
      view.setUint8(8, (view.getUint8(8) & 63) | 128);
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };

    function unwrap(result) {
      if (!result || typeof result.ok !== 'boolean') throw new Error('BAD_ENVELOPE');
      if (result.ok) return result.value;
      const error = new Error(
        typeof result.error?.message === 'string' ? result.error.message : 'REQUEST_FAILED',
      );
      error.code = result.error?.code;
      error.details = result.error?.details;
      throw error;
    }

    /**
     * Read the durable message id out of one Conversation context key.
     *
     * The engine keys a message Context as `<kind length>:<kind><id>`, and the
     * Chat flow row exposes that key as `data-chat-node-key`. The id is opaque
     * and may itself contain colons, so the prefix is matched, not split.
     */
    function messageIdOfNodeKey(key) {
      const prefix = `${USER_CONTEXT_KIND.length}:${USER_CONTEXT_KIND}`;
      if (typeof key !== 'string' || !key.startsWith(prefix)) return '';
      return key.slice(prefix.length);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // `locale/*.json` carry only the metadata the Host reads at boot, so this
        // half owns the dictionaries and registers them itself. A second instance
        // of this module may already hold the namespace; that duplicate is not
        // fatal (its dictionaries are identical), so the error is swallowed
        // instead of killing the whole Client half.
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { en: EN, zh: ZH });
          } catch {
            return () => {};
          }
        }, 'session-edit: dictionaries');
        const translate = ctx.locale.bind(NS);

        /**
         * Call one endpoint of this package's Host half over the plugin's own
         * same-origin prefix route. The route answers `{ ok, value }` or
         * `{ ok: false, error }`; a rejected request never reaches it (401/403),
         * so those statuses become a plain unavailable error.
         */
        function createClient() {
          return async function call(endpoint, payload, signal) {
            if (!ENDPOINT.test(endpoint)) throw new Error(`invalid endpoint ${JSON.stringify(endpoint)}`);
            let response;
            try {
              response = await fetch(`${CHANNEL}/${endpoint}`.slice(1), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload ?? {}),
                ...(signal === undefined ? {} : { signal }),
              });
            } catch (error) {
              if (error?.name === 'AbortError') throw error;
              throw new Error(translate('unavailable'));
            }
            if (response.status === 401 || response.status === 403) throw new Error(translate('unavailable'));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return unwrap(await response.json());
          };
        }
        const store = createStore();
        const call = createClient();

        const visibility = new Map();
        function watchSession(sessionId) {
          let item = visibility.get(sessionId);
          if (!item) {
            const style = document.createElement('style');
            style.dataset.sessionEditVisibility = sessionId;
            document.head.appendChild(style);
            item = { refs: 0, style, active: true };
            const update = async () => {
              try {
                const value = await call('listMessages', { sessionId });
                if (!item.active || !Array.isArray(value?.hiddenTurns)) return;
                style.textContent = value.hiddenTurns.filter(Number.isSafeInteger)
                  .map((turn) => `[data-chat-turn="${turn}"]{display:none!important}`).join('\n');
              } catch { /* Keep the last verified visibility on transient errors. */ }
            };
            item.timer = setInterval(update, 1500);
            visibility.set(sessionId, item);
            void update();
          }
          item.refs++;
          return () => {
            if (--item.refs !== 0) return;
            item.active = false;
            clearInterval(item.timer);
            item.style.remove();
            visibility.delete(sessionId);
          };
        }

        const useStore = () => {
          const [state, setState] = useState(store.get());
          useEffect(() => store.subscribe(() => setState(store.get())), []);
          return state;
        };

        const colors = {
          text: 'var(--dsw-alias-label-primary)',
          muted: 'var(--dsw-alias-label-secondary)',
          tertiary: 'var(--dsw-alias-label-tertiary)',
          border: 'var(--dsw-alias-border-l1)',
          overlay: 'var(--dsw-alias-bg-overlay)',
          accent: 'var(--dsw-alias-brand-primary)',
          danger: 'var(--dsw-alias-state-error-primary)',
        };

        const primaryStyle = {
          color: '#fff', background: colors.accent, border: 'none',
          borderRadius: 6, padding: '6px 12px', font: 'inherit', cursor: 'pointer',
        };
        const secondaryStyle = {
          ...primaryStyle, color: colors.text, background: 'transparent',
          border: `1px solid ${colors.border}`,
        };

        /** Styles for the injected action button, kept inside the plugin. */
        const ROW_ACTION_CLASS = 'session-edit-row-action';
        /**
         * Install the button stylesheet once per document.
         *
         * The stylesheet is keyed by a data attribute instead of a module flag:
         * a client reload rebuilds this module but not the DOM, so a flag would
         * append a second copy each time. Reusing the existing element also
         * refreshes its text after a hot update.
         */
        const installStyle = () => {
          if (typeof document === 'undefined') return;
          const css = `
.${ROW_ACTION_CLASS}{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:${colors.tertiary};cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.${ROW_ACTION_CLASS} svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
@media (hover:hover){.${ROW_ACTION_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover);color:${colors.muted}}}
`;
          let style = document.head.querySelector('style[data-session-edit="row-action"]');
          if (style === null) {
            style = document.createElement('style');
            style.dataset.sessionEdit = 'row-action';
            document.head.appendChild(style);
          }
          if (style.textContent !== css) style.textContent = css;
        };

        /**
         * Parse the message id a row owns, using only the semantic attributes
         * the Chat flow row publishes. Anything unexpected yields '' so the
         * row renders no action instead of guessing.
         */
        function readRowMessageId(row) {
          if (row === null) return '';
          const nodeKey = row.getAttribute('data-chat-node-key')
            ?? row.getAttribute('data-chat-anchor-key')
            ?? '';
          return messageIdOfNodeKey(nodeKey);
        }

        /**
         * Own the action button for one user row.
         *
         * The official Chat slot renders above the bubble and cannot reach the
         * built-in action row, so this component renders an inert anchor and
         * attaches the real button to the row's own `[data-clock="start"]`
         * actions. A MutationObserver re-attaches it if Chat re-renders that
         * row, and everything is removed on unmount.
         */
        function RowAction(props) {
          const anchorRef = useRef(null);
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';

          useEffect(() => {
            const anchor = anchorRef.current;
            if (anchor === null || typeof document === 'undefined') return undefined;
            const row = anchor.closest('[data-chat-flow-kind="user"]');
            if (row === null) return undefined;
            const messageId = readRowMessageId(row);
            if (messageId === '') return undefined;
            installStyle();
            const stopWatching = watchSession(sessionId);

            let button = null;
            /**
             * Seat the button in the row's own action strip, next to the time
             * and copy controls. If Chat does not publish that strip (a future
             * layout change, or a row that has none), fall back to sitting just
             * after the anchor above the bubble so the entry stays reachable
             * instead of disappearing silently.
             */
            const attach = () => {
              if (button === null) return;
              const actions = row.querySelector('[data-clock="start"]');
              if (actions !== null) {
                if (button.parentElement !== actions) actions.appendChild(button);
                return;
              }
              const seat = anchor.parentElement;
              if (seat !== null && button.parentElement !== seat) seat.insertBefore(button, anchor.nextSibling);
            };

            const onClick = (event) => {
              event.preventDefault();
              event.stopPropagation();
              store.set({ open: true, sessionId, messageId });
            };

            button = document.createElement('button');
            button.type = 'button';
            button.className = ROW_ACTION_CLASS;
            button.dataset.sessionEditAction = 'edit';
            button.title = translate('edit');
            button.setAttribute('aria-label', translate('edit'));
            button.addEventListener('click', onClick);
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 16 16');
            icon.setAttribute('width', '15');
            icon.setAttribute('height', '15');
            icon.setAttribute('fill', 'none');
            icon.setAttribute('stroke', 'currentColor');
            icon.setAttribute('stroke-width', '1.5');
            icon.setAttribute('stroke-linecap', 'round');
            icon.setAttribute('stroke-linejoin', 'round');
            icon.setAttribute('aria-hidden', 'true');
            for (const d of ['M11.8 2.3a1.5 1.5 0 0 1 2.1 2.1l-7.5 7.5-3.1.8.8-3.1 7.7-7.3Z', 'm10.5 3.6 2 2']) {
              const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
              path.setAttribute('d', d);
              icon.appendChild(path);
            }
            button.appendChild(icon);

            attach();
            const observer = typeof MutationObserver === 'function'
              ? new MutationObserver(() => attach())
              : null;
            observer?.observe(row, { childList: true, subtree: true });

            return () => {
              observer?.disconnect();
              stopWatching();
              button.removeEventListener('click', onClick);
              button.remove();
              button = null;
            };
          }, [sessionId]);

          // The anchor is invisible: it exists only to locate the owning row.
          return h('span', {
            ref: anchorRef,
            hidden: true,
            'data-session-edit-anchor': '',
          });
        }

        function Panel(props) {
          const t = typeof props.t === 'function' ? props.t : translate;
          const state = useStore();
          const [phase, setPhase] = useState('idle');
          const [target, setTarget] = useState(null);
          const [text, setText] = useState('');
          const [error, setError] = useState('');
          const requestRef = useRef('');
          const textareaRef = useRef(null);

          const describe = (value) => (value instanceof Error ? value.message : String(value));
          const refusal = (code) => {
            const key = `refusal.${code}`;
            const text = t(key);
            if (typeof text === 'string' && text !== key) return text;
            return EN[key] ?? EN['refusal.UNKNOWN_MESSAGE'];
          };

          const reset = () => {
            setPhase('idle');
            setTarget(null);
            setText('');
            setError('');
            requestRef.current = '';
          };

          const close = () => {
            store.set({ open: false, sessionId: '', messageId: '' });
            reset();
          };

          const load = useCallback(async () => {
            setPhase('loading');
            setError('');
            try {
              const value = await call('listMessages', { sessionId: state.sessionId });
              const messages = Array.isArray(value?.messages) ? value.messages : null;
              if (messages === null) throw new Error(t('invalid'));
              const found = messages.find((entry) => entry?.messageId === state.messageId);
              if (found === undefined) {
                setError(t('refusal.UNKNOWN_MESSAGE'));
                setPhase('error');
                return;
              }
              setTarget(found);
              if (found.editable !== true) {
                setError(refusal(found.code));
                setPhase('error');
                return;
              }
              setText(typeof found.text === 'string' ? found.text : '');
              setPhase('editing');
            } catch (caught) {
              setError(describe(caught));
              setPhase('error');
            }
          }, [state.sessionId, state.messageId, t]);

          useEffect(() => {
            if (!state.open) return;
            if (!state.sessionId || !state.messageId) return;
            reset();
            void load();
          }, [state.open, state.sessionId, state.messageId, load]);

          useEffect(() => {
            if (!state.open) return undefined;
            const onKey = (event) => {
              if (event.key === 'Escape') close();
            };
            globalThis.addEventListener?.('keydown', onKey);
            return () => globalThis.removeEventListener?.('keydown', onKey);
            // `close` only touches the store and local setters.
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [state.open]);

          useEffect(() => {
            if (phase === 'editing') textareaRef.current?.focus?.();
          }, [phase]);

          const submit = async (event) => {
            event.preventDefault();
            if (phase !== 'editing' || target === null) return;
            if (text.trim() === '') { setError(t('empty')); return; }
            if (!requestRef.current) requestRef.current = uuid();
            setPhase('saving');
            setError('');
            try {
              await call('editMessage', {
                sessionId: state.sessionId,
                requestId: requestRef.current,
                eventSeq: target.eventSeq,
                text,
              });
              close();
            } catch (caught) {
              setError(describe(caught));
              setPhase('editing');
            }
          };

          if (!state.open) return null;

          return h('div', {
            style: {
              position: 'fixed', inset: 0, zIndex: 60, pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0, 0, 0, 0.45)',
            },
            onClick: (event) => {
              if (event.target === event.currentTarget) close();
            },
          }, h('section', {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('title'),
            style: {
              width: 'min(560px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 64px)',
              overflow: 'auto', display: 'grid', gap: 12, padding: 20,
              color: colors.text, background: colors.overlay,
              border: `1px solid ${colors.border}`, borderRadius: 12,
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.35)',
            },
          },
            h('div', {
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
            },
              h('strong', { style: { fontSize: 15 } }, t('title')),
              h('button', {
                type: 'button', style: { ...secondaryStyle, padding: '2px 8px' }, onClick: close,
              }, t('close'))),
            h('p', { style: { margin: 0, fontSize: 13, color: colors.muted } }, t('warning')),
            error !== '' && h('div', {
              role: 'alert', style: { fontSize: 13, color: colors.danger },
            }, phase === 'error' ? error : [t('failed'), ' ', error]),
            phase === 'loading' && h('div', { role: 'status', style: { fontSize: 13 } }, t('loading')),
            (phase === 'editing' || phase === 'saving') && h('form', {
              onSubmit: submit, style: { display: 'grid', gap: 10 },
            },
              h('label', { style: { fontSize: 13, color: colors.muted } }, t('label'),
                h('textarea', {
                  ref: textareaRef,
                  value: text,
                  onChange: (event) => setText(event.target.value),
                  rows: 7,
                  disabled: phase === 'saving',
                  style: {
                    display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 6,
                    padding: 10, color: colors.text, background: 'transparent',
                    border: `1px solid ${colors.border}`, borderRadius: 8,
                    font: 'inherit', resize: 'vertical',
                  },
                })),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                h('button', { type: 'button', style: secondaryStyle, onClick: close }, t('cancel')),
                h('button', {
                  type: 'submit', style: { ...primaryStyle, opacity: phase === 'saving' ? 0.7 : 1 },
                  disabled: phase === 'saving',
                }, phase === 'saving' ? t('saving') : t('submit')))),
            phase === 'error' && h('button', {
              type: 'button', style: primaryStyle, onClick: load,
            }, t('retry'))));
        }

        // The dialog is registered first: if the row action below cannot be
        // seated, the failure must not also hide the dialog from the frame.
        ctx.slots.inject('shell.overlay', () => [
          ctx.slots.register({
            name: 'shell.overlay', id: 'session-edit.dialog', order: 90,
            locale: NS, label: () => translate('title'),
          }, Panel),
        ]);

        /**
         * Chain slot above each user bubble. The Host declares this slot for
         * message-source decoration; we use it to own an action in the row.
         */
        ctx.slots.inject('conversation.chat.user.before', () => [
          ctx.slots.register({
            name: 'conversation.chat.user.before',
            locale: NS,
            select: (owner) => (owner?.kind === 'user' ? { kind: 'user' } : null),
          }, RowAction),
        ]);
      },
    };
  },
});
