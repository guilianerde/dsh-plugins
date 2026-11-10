window.__ModuleLoader__.load({
  id: '@local/session-delete',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useState, useCallback } = React;

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions', 'remote'],
      apply(ctx) {
        // Resolve host RPC bridge once here. Cordis traces service property reads and
        // throws when they happen outside this apply context (e.g. inside React event
        // handlers), so capture the plugin-namespace proxy up front.
        const remote = ctx.get('remote');
        // Host half registers under the cordis entry id ('session-delete' per
        // cordis.patch.yml) and under the package name ('@local/session-delete');
        // resolve via ctx.get to avoid tracing issues and fall back gracefully.
        const hostApi = ctx.get('remote.session-delete')
          ?? ctx.get('remote.@local/session-delete')
          ?? (remote && remote['@local/session-delete'])
          ?? (remote && remote['session-delete']);

        if (!hostApi) {
          console.error('[session-delete] host remote API not available; plugin disabled.');
          return;
        }

        // Register translations
        const t = ctx.locale.bind('@local/session-delete');
        ctx.locale.register('@local/session-delete', 'en', {
          'menu.label': 'Delete session',
          'confirm.title': 'Delete session permanently?',
          'confirm.message': 'This will permanently delete the session and all its messages from your local storage. This action cannot be undone.',
          'confirm.ok': 'Delete',
          'confirm.cancel': 'Cancel',
          'delete.success': 'Session deleted',
          'delete.error': 'Failed to delete session: ',
          'edit.menu.label': 'Edit & Rewind',
          'edit.title': 'Edit message and rewind session',
          'edit.description': 'Edit the content of this message. After confirmation, all messages after this point will be permanently discarded and the session will continue from this edited message.',
          'edit.content.label': 'New message content:',
          'edit.confirm': 'Confirm & Rewind',
          'edit.cancel': 'Cancel',
          'edit.success': 'Session rewound successfully',
          'edit.error': 'Failed to rewind session: ',
          'edit.warning': '⚠️ This will discard all messages after this point and cannot be undone.',
        });
        ctx.locale.register('@local/session-delete', 'zh', {
          'menu.label': '删除会话',
          'confirm.title': '永久删除会话？',
          'confirm.message': '此操作将从本地存储中永久删除该会话及其所有消息，无法撤销。',
          'confirm.ok': '删除',
          'confirm.cancel': '取消',
          'delete.success': '会话已删除',
          'delete.error': '删除会话失败：',
          'edit.menu.label': '编辑并回退',
          'edit.title': '编辑消息并回退会话',
          'edit.description': '编辑这条消息的内容，确认后此消息之后的所有内容将被永久丢弃，会话将从这条编辑后的消息处继续。',
          'edit.content.label': '新的消息内容：',
          'edit.confirm': '确认并回退',
          'edit.cancel': '取消',
          'edit.success': '会话回退成功',
          'edit.error': '回退会话失败：',
          'edit.warning': '⚠️ 此操作将丢弃这条消息之后的所有内容，无法撤销。',
        });

        // Styles
        const destructiveStyle = {
          color: 'var(--color-danger-600, #dc2626)',
        };

        const warningStyle = {
          color: 'var(--color-warning-600, #d97706)',
          fontSize: '13px',
          marginTop: '8px',
          padding: '8px',
          backgroundColor: 'var(--color-warning-50, #fffbeb)',
          borderRadius: '4px',
        };

        // Delete session menu item component
        function DeleteMenuItem(props) {
          const { sessionId, displayTitle } = props;

          const handleClick = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Confirm dialog
            const confirmed = window.confirm(
              `${t('confirm.title')}\n\n${t('confirm.message')}` +
              (displayTitle ? `\n\n会话: ${displayTitle}` : '')
            );
            if (!confirmed) return;

            try {
              // Call host RPC to delete
              const result = await hostApi.deleteSession({ sessionId });
              if (result?.ok) {
                // If this was the currently open session, navigate to new session
                const currentSessionId = ctx.sessions?.activeSessionId;
                if (currentSessionId === sessionId) {
                  ctx.uiWorkspace.startSession();
                }
              }
            } catch (err) {
              console.error('Failed to delete session:', err);
              window.alert(t('delete.error') + (err.message || err));
            }
          };

          return h(
            'div',
            {
              role: 'menuitem',
              onClick: handleClick,
              style: {
                ...destructiveStyle,
                padding: '8px 12px',
                cursor: 'pointer',
                borderRadius: '4px',
                fontSize: '14px',
              },
              onMouseEnter: (e) => {
                e.currentTarget.style.backgroundColor = 'var(--color-danger-50, #fef2f2)';
              },
              onMouseLeave: (e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              },
            },
            t('menu.label')
          );
        }

        // Edit message modal component
        function EditMessageModal({ message, onClose, onConfirm }) {
          const [content, setContent] = useState(message?.content || '');
          const [loading, setLoading] = useState(false);

          const handleSubmit = useCallback(async (e) => {
            e.preventDefault();
            if (!content.trim()) {
              return;
            }
            setLoading(true);
            try {
              await onConfirm(content.trim());
              onClose();
            } catch (err) {
              console.error('Failed to rewind:', err);
              window.alert(t('edit.error') + (err.message || err));
            } finally {
              setLoading(false);
            }
          }, [content, onConfirm, onClose]);

          return h(
            'div',
            {
              style: {
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10000,
              },
              onClick: onClose,
            },
            h(
              'div',
              {
                style: {
                  backgroundColor: 'var(--color-bg-primary, #ffffff)',
                  borderRadius: '8px',
                  padding: '24px',
                  width: '90%',
                  maxWidth: '600px',
                  maxHeight: '80vh',
                  overflow: 'auto',
                  boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                },
                onClick: (e) => e.stopPropagation(),
              },
              h('h3', { style: { margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600 } }, t('edit.title')),
              h('p', { style: { margin: '0 0 16px 0', color: 'var(--color-text-secondary, #6b7280)', fontSize: '14px', lineHeight: 1.5 } }, t('edit.description')),
              h(
                'form',
                { onSubmit: handleSubmit },
                h(
                  'label',
                  { style: { display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 500 } },
                  t('edit.content.label')
                ),
                h('textarea', {
                  value: content,
                  onChange: (e) => setContent(e.target.value),
                  style: {
                    width: '100%',
                    minHeight: '120px',
                    padding: '10px 12px',
                    border: '1px solid var(--color-border-primary, #d1d5db)',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                    marginBottom: '8px',
                  },
                  disabled: loading,
                  autoFocus: true,
                }),
                h('div', { style: warningStyle }, t('edit.warning')),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: onClose,
                      disabled: loading,
                      style: {
                        padding: '8px 16px',
                        borderRadius: '6px',
                        border: '1px solid var(--color-border-primary, #d1d5db)',
                        backgroundColor: 'var(--color-bg-secondary, #f9fafb)',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                      },
                    },
                    t('edit.cancel')
                  ),
                  h(
                    'button',
                    {
                      type: 'submit',
                      disabled: loading || !content.trim(),
                      style: {
                        padding: '8px 16px',
                        borderRadius: '6px',
                        border: 'none',
                        backgroundColor: 'var(--color-primary-600, #2563eb)',
                        color: 'white',
                        cursor: loading || !content.trim() ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                        fontWeight: 500,
                        opacity: loading || !content.trim() ? 0.7 : 1,
                      },
                    },
                    loading ? '...' : t('edit.confirm')
                  )
                )
              )
            )
          );
        }

        // Edit message menu item component
        function EditMessageMenuItem(props) {
          const { message } = props;
          const [showModal, setShowModal] = useState(false);

          // Only show for user messages
          if (message?.role !== 'user' && message?.type !== 'user/message') {
            return null;
          }

          // Extract message content
          const getMessageContent = (msg) => {
            if (typeof msg?.content === 'string') return msg.content;
            if (Array.isArray(msg?.content)) {
              return msg.content
                .filter(part => part?.type === 'text')
                .map(part => part.text)
                .join('\n');
            }
            if (msg?.data?.content) return getMessageContent(msg.data);
            return '';
          };

          const messageContent = getMessageContent(message);
          const messageId = message?.id || message?.messageId || message?.event?.data?.id;

          if (!messageId || !messageContent) {
            return null;
          }

          const handleClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowModal(true);
          };

          const handleConfirm = async (newContent) => {
            const sessionId = ctx.sessions?.activeSessionId;
            if (!sessionId) {
              throw new Error('No active session');
            }

            const result = await hostApi.rewindSessionToMessage({
              sessionId,
              messageId,
              newContent,
            });

            if (result?.ok) {
              // Success - session will reload automatically from backend
              window.alert(t('edit.success') + `\n保留了 ${result.messagesKept} 条消息，丢弃了 ${result.messagesDiscarded} 条消息。`);
              // Force refresh the UI
              window.location.reload();
            } else {
              throw new Error('Unknown error');
            }
          };

          return h(
            React.Fragment,
            null,
            h(
              'div',
              {
                role: 'menuitem',
                onClick: handleClick,
                style: {
                  padding: '8px 12px',
                  cursor: 'pointer',
                  borderRadius: '4px',
                  fontSize: '14px',
                },
                onMouseEnter: (e) => {
                  e.currentTarget.style.backgroundColor = 'var(--color-neutral-100, #f3f4f6)';
                },
                onMouseLeave: (e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                },
              },
              t('edit.menu.label')
            ),
            showModal && h(EditMessageModal, {
              message: { content: messageContent },
              onClose: () => setShowModal(false),
              onConfirm: handleConfirm,
            })
          );
        }

        // Register delete menu item in the session "..." menu
        const disposeSessionMenu = ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'session-delete',
              order: 100, // Place after Archive (which has default order 0)
              label: () => t('menu.label'),
            },
            DeleteMenuItem
          )
        );

        // Inject edit button to user messages via MutationObserver (since no public slot exists for user message actions)
        const EDIT_BUTTON_CLASS = 'dsh-session-delete-edit-btn';
        let activeEditHandler = null;

        // Helper to find message ID from element
        const getMessageInfoFromElement = (el) => {
          // Walk up to find message container
          let messageEl = el.closest('[data-message-id], [data-id], [class*="message"], [class*="Message"]');
          while (messageEl && !messageEl.getAttribute('data-message-id') && !messageEl.getAttribute('data-id')) {
            messageEl = messageEl.parentElement;
            if (!messageEl || messageEl === document.body) return null;
          }
          if (!messageEl) return null;

          const messageId = messageEl.getAttribute('data-message-id') || messageEl.getAttribute('data-id');
          if (!messageId) return null;

          // Check if this is a user message
          const isUserMessage = messageEl.className.includes('user') || messageEl.getAttribute('data-role') === 'user';
          if (!isUserMessage) return null;

          // Extract content from message
          const contentEl = messageEl.querySelector('[class*="content"], [class*="Content"], .markdown-body, p');
          if (!contentEl) return null;
          const content = contentEl.textContent.trim();
          if (!content) return null;

          return { messageId, content, messageEl };
        };

        // Handle edit button click
        const handleEditButtonClick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const info = getMessageInfoFromElement(e.currentTarget);
          if (!info) return;

          // Show modal - use React portal approach by creating a root element
          const modalRoot = document.createElement('div');
          document.body.appendChild(modalRoot);

          const closeModal = () => {
            ReactDOM.unmountComponentAtNode(modalRoot);
            modalRoot.remove();
            activeEditHandler = null;
          };

          const handleConfirm = async (newContent) => {
            const sessionId = ctx.sessions?.activeSessionId;
            if (!sessionId) throw new Error('No active session');

            const result = await hostApi.rewindSessionToMessage({
              sessionId,
              messageId: info.messageId,
              newContent,
            });

            if (result?.ok) {
              window.alert(t('edit.success') + `\n保留了 ${result.messagesKept} 条消息，丢弃了 ${result.messagesDiscarded} 条消息。`);
              window.location.reload();
            } else {
              throw new Error('Unknown error');
            }
          };

          // Render modal
          ReactDOM.render(
            h(EditMessageModal, {
              message: { content: info.content },
              onClose: closeModal,
              onConfirm: handleConfirm,
            }),
            modalRoot
          );
          activeEditHandler = closeModal;
        };

        // Add edit buttons to existing user messages
        const addEditButtons = () => {
          // Try multiple selectors to find message action buttons
          const actionButtons = document.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label]');
          let copyBtn = null;
          actionButtons.forEach(btn => {
            const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
            if (label.includes('copy') || label.includes('复制')) {
              copyBtn = btn;
            }
          });

          // If no copy button found, look for the copy icon directly
          if (!copyBtn) {
            const copyIcons = document.querySelectorAll('svg');
            copyIcons.forEach(icon => {
              if (icon.innerHTML.includes('M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z') || 
                  icon.outerHTML.includes('copy') || icon.parentElement?.getAttribute('aria-label')?.includes('复制')) {
                copyBtn = icon.closest('button') || icon.parentElement;
              }
            });
          }

          if (!copyBtn) {
            // Fallback: add button directly to all user message bubbles
            const userMessages = document.querySelectorAll('[class*="user-message"], [class*="UserMessage"], [data-role="user"], [class*="message-user"]');
            userMessages.forEach(msgEl => {
              if (msgEl.querySelector(`.${EDIT_BUTTON_CLASS}`)) return;
              
              // Find actions area - usually at the bottom right
              let actionsContainer = msgEl.querySelector('[class*="actions"], [class*="Actions"], [class*="footer"], [class*="Footer"]');
              if (!actionsContainer) {
                actionsContainer = document.createElement('div');
                actionsContainer.style.cssText = 'display: flex; gap: 4px; justify-content: flex-end; margin-top: 4px; padding-right: 8px;';
                msgEl.appendChild(actionsContainer);
              }

              // Create edit button
              const editBtn = document.createElement('button');
              editBtn.className = EDIT_BUTTON_CLASS;
              editBtn.type = 'button';
              editBtn.title = t('edit.menu.label');
              editBtn.ariaLabel = t('edit.menu.label');
              editBtn.innerHTML = `✏️`;
              editBtn.style.cssText = `
                background: transparent;
                border: none;
                cursor: pointer;
                padding: 4px 6px;
                border-radius: 4px;
                color: var(--color-text-secondary, #6b7280);
                font-size: 14px;
                line-height: 1;
                transition: all 0.15s ease;
              `;
              editBtn.addEventListener('mouseenter', () => {
                editBtn.style.backgroundColor = 'var(--color-neutral-100, #f3f4f6)';
                editBtn.style.color = 'var(--color-primary-600, #2563eb)';
              });
              editBtn.addEventListener('mouseleave', () => {
                editBtn.style.backgroundColor = 'transparent';
                editBtn.style.color = 'var(--color-text-secondary, #6b7280)';
              });
              editBtn.addEventListener('click', handleEditButtonClick);

              actionsContainer.appendChild(editBtn);
            });
            return;
          }

          const actionsContainer = copyBtn.parentElement;
          if (!actionsContainer || actionsContainer.querySelector(`.${EDIT_BUTTON_CLASS}`)) return;

          // Create edit button
          const editBtn = document.createElement('button');
          editBtn.className = EDIT_BUTTON_CLASS;
          editBtn.type = 'button';
          editBtn.title = t('edit.menu.label');
          editBtn.ariaLabel = t('edit.menu.label');
          editBtn.innerHTML = `✏️`;
          editBtn.style.cssText = `
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 4px 6px;
            border-radius: 4px;
            color: var(--color-text-secondary, #6b7280);
            font-size: 14px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-right: 4px;
            transition: all 0.15s ease;
          `;
          editBtn.addEventListener('mouseenter', () => {
            editBtn.style.backgroundColor = 'var(--color-neutral-100, #f3f4f6)';
            editBtn.style.color = 'var(--color-primary-600, #2563eb)';
          });
          editBtn.addEventListener('mouseleave', () => {
            editBtn.style.backgroundColor = 'transparent';
            editBtn.style.color = 'var(--color-text-secondary, #6b7280)';
          });
          editBtn.addEventListener('click', handleEditButtonClick);

          // Insert before copy button
          actionsContainer.insertBefore(editBtn, copyBtn);
        };

        // Observe DOM changes to add buttons to new messages
        const observer = new MutationObserver((mutations) => {
          let shouldAdd = false;
          mutations.forEach(mutation => {
            if (mutation.addedNodes.length > 0) {
              shouldAdd = true;
            }
          });
          if (shouldAdd) {
            addEditButtons();
          }
        });

        // Start observing
        try {
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        } catch (e) {
          console.error('Failed to start observer:', e);
        }

        // Debug: confirm plugin loaded - remove this alert after testing
        window.alert('✅ dsh-session-delete 插件已加载 v1.1.0\n如果看到此提示说明插件安装成功，按钮应该会自动出现在你的消息右下角。');
        console.log('✅ dsh-session-delete plugin loaded, v1.1.0');

        // Add buttons to existing messages on load - retry multiple times
        const addButtonsWithRetry = (retries = 10) => {
          addEditButtons();
          if (retries > 0) {
            setTimeout(() => addButtonsWithRetry(retries - 1), 1000);
          }
        };
        setTimeout(() => addButtonsWithRetry(), 500);

        // Cleanup
        ctx.effect(() => () => {
          observer.disconnect();
          if (activeEditHandler) activeEditHandler();
          document.querySelectorAll(`.${EDIT_BUTTON_CLASS}`).forEach(btn => btn.remove());
          disposeSessionMenu();
        });
      },
    };
  },
});
