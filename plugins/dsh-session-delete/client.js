window.__ModuleLoader__.load({
  id: '@local/session-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = '@local/session-delete';
    const CHANNEL = '/session-delete';
    const ENDPOINT = /^[A-Za-z0-9_$.-]+$/;
    const DANGER = 'var(--dsw-alias-state-error-primary, #d92d20)';
    const DANGER_BACKGROUND = 'var(--dsw-alias-interactive-bg-danger-hover, rgba(217, 45, 32, 0.1))';

    const EN = {
      'menu.label': 'Delete session permanently',
      'confirm.title': 'Permanently delete this session?',
      'confirm.message': 'All messages and local session files for this conversation will be deleted. This action cannot be undone.',
      'untitled': 'Untitled session',
      'error.notFound': 'This session no longer exists.',
      'error.unsafe': 'The session storage path could not be verified, so nothing was deleted.',
      'error.failed': 'The session could not be deleted. It may still be in use; close DSH and try again.',
      'error.invalid': 'The delete request was invalid.',
      'error.offline': 'This window is not connected to the host.',
      'error.refresh': 'The session was deleted, but the current view could not be refreshed.',
    };

    const ZH = {
      'menu.label': '永久删除会话',
      'confirm.title': '永久删除这个会话？',
      'confirm.message': '这个会话的全部消息和本地会话文件都会被删除。此操作无法撤销。',
      'untitled': '未命名会话',
      'error.notFound': '这个会话已经不存在。',
      'error.unsafe': '无法验证这个会话的存储路径，因此没有删除任何内容。',
      'error.failed': '无法删除这个会话。它可能仍在使用中，请关闭 DSH 后重试。',
      'error.invalid': '删除请求无效。',
      'error.offline': '当前窗口未连接到主机。',
      'error.refresh': '会话已删除，但当前页面未能刷新。',
    };

    function errorResult(result) {
      if (!result || typeof result.ok !== 'boolean') return new Error('BAD_ENVELOPE');
      if (result.ok) return undefined;
      const error = new Error(
        typeof result.error?.message === 'string' ? result.error.message : 'REQUEST_FAILED',
      );
      error.code = result.error?.code;
      return error;
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { en: EN, zh: ZH });
          } catch {
            return () => {};
          }
        }, 'session-delete: dictionaries');

        const t = ctx.locale.bind(NS);
        const sessions = ctx.get('sessions');
        const uiWorkspace = ctx.get('uiWorkspace');

        async function call(endpoint, payload) {
          if (!ENDPOINT.test(endpoint)) throw new Error('INVALID_ENDPOINT');

          let response;
          try {
            response = await fetch(`${CHANNEL}/${endpoint}`.slice(1), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
          } catch {
            throw new Error(t('error.offline'));
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error(t('error.offline'));
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const result = await response.json();
          const failure = errorResult(result);
          if (failure !== undefined) throw failure;
          return result.value;
        }

        function currentMainViewSessionId() {
          const byId = sessions?.list?.getSnapshot?.().byId;
          if (typeof byId !== 'object' || byId === null) return undefined;
          return Object.values(byId)
            .find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
        }

        function localizedError(error) {
          switch (error?.code) {
            case 'SESSION_NOT_FOUND': return t('error.notFound');
            case 'UNSAFE_SESSION_PATH': return t('error.unsafe');
            case 'INVALID_REQUEST': return t('error.invalid');
            case 'DELETE_FAILED': return t('error.failed');
            default: return error?.message || t('error.failed');
          }
        }

        function DeleteMenuItem(props) {
          const menuState = typeof props.useMenuOpenState === 'function'
            ? props.useMenuOpenState()
            : [true, () => {}];
          const setMenuOpen = menuState[1];
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
          const title = typeof props.displayTitle === 'string' && props.displayTitle.trim() !== ''
            ? props.displayTitle.trim()
            : t('untitled');

          const remove = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(false);
            if (sessionId === '') return;

            const wasCurrent = currentMainViewSessionId() === sessionId;
            const confirmed = window.confirm(
              `${t('confirm.title')}\n\n${title}\n\n${t('confirm.message')}`,
            );
            if (!confirmed) return;

            try {
              await call('deleteSession', { sessionId });
              if (wasCurrent && typeof uiWorkspace?.startSession === 'function') {
                try {
                  await uiWorkspace.startSession();
                } catch {
                  window.alert(t('error.refresh'));
                }
              }
            } catch (error) {
              window.alert(localizedError(error));
            }
          };

          return h('button', {
            type: 'button',
            role: 'menuitem',
            'aria-label': t('menu.label'),
            onClick: remove,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '7px 12px',
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: DANGER,
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.background = DANGER_BACKGROUND;
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent';
            },
          },
            h('svg', {
              viewBox: '0 0 24 24',
              width: 16,
              height: 16,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
              h('path', { d: 'M4 7h16' }),
              h('path', { d: 'M9 7V4h6v3' }),
              h('path', { d: 'M6.5 7l.8 13h9.4l.8-13' }),
              h('path', { d: 'M10 11v5M14 11v5' })),
            h('span', null, t('menu.label')));
        }

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete',
            order: 500,
            locale: NS,
            label: () => t('menu.label'),
          }, DeleteMenuItem));
      },
    };
  },
});
