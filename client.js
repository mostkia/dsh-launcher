/**
 * @mostkia/dsh-launcher - client half.
 *
 * Registers one action into the sidebar's official `sidebar.footer.action` slot
 * (the seat the shell allocates beside Settings) and renders the power dialog:
 * shutdown / restart, each behind a second confirmation, with the logon-start
 * switch at the bottom.
 *
 * Deliberately dependency-free: React comes from the browser module table and
 * nothing else is imported - no `@deepseek-ai/dsh-client-ui-*` package - so the
 * UI is hand-built from theme tokens only, per the plugin-development rules.
 * Visible text goes through the client locale service.
 */
window.__ModuleLoader__.load({
  id: '@mostkia/dsh-launcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Optional portal target; without react-dom the dialog renders in place. */
    let createPortal = null;
    try {
      const reactDom = require('react-dom');
      if (reactDom && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal;
    } catch {
      createPortal = null;
    }

    const NS = 'dsh-launcher';
    const PREFIX = '/_dsh-launcher';
    const STATUS_TIMEOUT_MS = 4000;

    const zh = {
      'action.label': '电源',
      'action.tip': '关机 / 重启',
      'dialog.title': '电源',
      'dialog.desc': '关闭或重启 DSH 服务。正在进行的对话会被中断。',
      'action.shutdown': '关机',
      'action.restart': '重启',
      'action.cancel': '取消',
      'action.close': '关闭',
      'confirm.shutdown.title': '确认关机？',
      'confirm.shutdown.desc': 'DSH 会先结束正在进行的任务、释放端口，然后退出进程。之后需要手动重新启动。',
      'confirm.restart.title': '确认重启？',
      'confirm.restart.desc': 'DSH 会优雅退出，随后由系统托盘启动器重新拉起；本页稍后会自动刷新。',
      'confirm.ok.shutdown': '确认关机',
      'confirm.ok.restart': '确认重启',
      'autostart.label': '开机自启动',
      'autostart.hint': '登录 Windows 后自动启动托盘与 DSH',
      'autostart.loading': '读取中…',
      'autostart.unsupported': '未检测到启动器：请先运行包内 tray\\install.cmd 安装托盘。',
      'busy.shutdown': '正在关闭 DSH 服务…',
      'busy.restart': '正在重启 DSH 服务…',
      'done.shutdown': '已关闭。本页可以安全关闭。',
      'done.shutdown.stillrunning': '服务仍在响应，可能没有真正关闭，请手动检查。',
      'done.restart': '已重启，正在等待服务恢复…',
      'done.restart.ok': '服务已恢复，正在刷新页面…',
      'done.restart.timeout': '服务未在预期时间内恢复，请手动刷新页面。',
      'error.prefix': '操作失败：',
      'error.network': '无法连接 DSH 服务',
      'no.supervisor': '未检测到托盘启动器：本次重启已取消（不会重启进程）。安装托盘后即可使用。',
      'error.tray-not-installed': '未检测到启动器安装',
      'error.windows-only': '仅 Windows 支持开机自启动',
      'error.registry-write-failed': '写入注册表失败',
    };

    const en = {
      'action.label': 'Power',
      'action.tip': 'Shutdown / restart',
      'dialog.title': 'Power',
      'dialog.desc': 'Shut down or restart the DSH service. A running conversation is interrupted.',
      'action.shutdown': 'Shut down',
      'action.restart': 'Restart',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'confirm.shutdown.title': 'Shut down DSH?',
      'confirm.shutdown.desc': 'DSH finishes the current work, releases the port, then exits. You will have to start it again yourself.',
      'confirm.restart.title': 'Restart DSH?',
      'confirm.restart.desc': 'DSH exits gracefully and the Windows tray launcher starts it again; this page reloads by itself.',
      'confirm.ok.shutdown': 'Shut down',
      'confirm.ok.restart': 'Restart',
      'autostart.label': 'Start at logon',
      'autostart.hint': 'Start the tray and DSH after you sign in to Windows',
      'autostart.loading': 'Reading…',
      'autostart.unsupported': 'No launcher found: run tray\\install.cmd from the package first.',
      'busy.shutdown': 'Shutting DSH down…',
      'busy.restart': 'Restarting DSH…',
      'done.shutdown': 'Shut down. This page can be closed.',
      'done.shutdown.stillrunning': 'The service is still answering, so it may not have shut down. Check it manually.',
      'done.restart': 'Restarted, waiting for the service…',
      'done.restart.ok': 'Service is back, reloading…',
      'done.restart.timeout': 'The service did not come back in time; reload this page manually.',
      'error.prefix': 'Failed: ',
      'error.network': 'cannot reach the DSH service',
      'no.supervisor': 'No tray launcher detected, so the restart was cancelled (the process keeps running). Install the tray to use it.',
      'error.tray-not-installed': 'no launcher installation found',
      'error.windows-only': 'logon start is Windows-only',
      'error.registry-write-failed': 'registry write failed',
    };

    const CSS = [
      // The shell gives this seat its own row above Settings, and the foot stacks
      // the two rows in a column. To sit *beside* Settings instead - which is how
      // the layout is meant to read - the wide-mode button becomes a compact pill
      // floating over the right end of the Settings row: the negative bottom margin
      // cancels the row it would otherwise occupy (so no height is wasted and
      // Settings moves up into it), while top/z-index place it inside that row and
      // above it for pointer events. Only the wide column does this; the 56px rail
      // keeps two stacked icons, where there is no horizontal room to share.
      '.dsl-power{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:36px;min-height:36px;',
      'width:auto;margin:0 -2px -36px auto;padding:7px 10px;border:none;border-radius:var(--dsw-radius-md);background:transparent;',
      'position:relative;z-index:2;top:7px;',
      'color:var(--dsw-alias-label-primary);font:inherit;line-height:22px;text-align:left;cursor:pointer}',
      '.dsl-power:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsl-power:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsl-power--rail{width:36px;justify-content:center;margin:0;padding:0;top:0;z-index:auto}',
      '.dsl-power__glyph{flex:none;display:inline-flex;align-items:center;justify-content:center}',
      '.dsl-power__label{white-space:nowrap}',
      '.dsl-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(2px)}',
      '.dsl-card{box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow:auto;',
      'padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);',
      'font-family:var(--dsw-font-family)}',
      '.dsl-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}',
      '.dsl-title{margin:0;font-size:15px;font-weight:600}',
      '.dsl-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'border-radius:var(--dsw-radius-sm);padding:2px 6px;font:inherit}',
      '.dsl-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsl-desc{margin:0 0 16px;font-size:13px;color:var(--dsw-alias-label-secondary);line-height:20px}',
      '.dsl-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}',
      '.dsl-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:var(--dsw-radius-md);',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);',
      'font:inherit;cursor:pointer}',
      '.dsl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsl-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dsl-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsl-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsl-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dsl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:14px;',
      'border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsl-row__text{display:flex;flex-direction:column;gap:2px}',
      '.dsl-row__label{font-size:13px}',
      '.dsl-row__hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}',
      '.dsl-switch{position:relative;flex:none;width:40px;height:22px;border-radius:11px;border:none;padding:0;',
      'background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s var(--ds-ease-in-out)}',
      '.dsl-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsl-switch:disabled{opacity:.5;cursor:not-allowed}',
      '.dsl-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsl-switch__knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;',
      'background:var(--dsw-alias-bg-layer-1);transition:transform .15s var(--ds-ease-in-out)}',
      '.dsl-switch[aria-checked="true"] .dsl-switch__knob{transform:translateX(18px)}',
      '.dsl-note{margin:0 0 14px;font-size:13px;line-height:20px}',
      '.dsl-note--error{color:var(--dsw-alias-state-error-primary)}',
      '.dsl-note--ok{color:var(--dsw-alias-state-success-primary)}',
      '.dsl-note--busy{color:var(--dsw-alias-label-secondary)}',
    ].join('');

    /** The 16x16 power glyph, drawn in the host icon language (1px, currentColor). */
    function PowerGlyph(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
        },
        h('path', {
          d: 'M10.87 4.9A5 5 0 1 1 5.13 4.9',
          stroke: 'currentColor',
          strokeLinecap: 'round',
        }),
        h('path', { d: 'M8 1.4V7.2', stroke: 'currentColor', strokeLinecap: 'round' }),
      );
    }

    /** One round trip to the host half. */
    async function request(path, options) {
      const res = await fetch(PREFIX + path, Object.assign({ headers: { accept: 'application/json' } }, options));
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    }

    /** Resolve true once the service answers again, or false at the deadline. */
    async function waitForService(deadline) {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try {
          const res = await fetch(PREFIX + '/status', { headers: { accept: 'application/json' } });
          if (res.ok) return true;
        } catch {
          /* still down */
        }
      }
      return false;
    }

    /**
     * Resolve true once the service stops answering, or false at the deadline.
     * The host half replies before it asks for an exit, so "shut down" is only
     * true once nothing answers any more; without this check a failed exit would
     * be reported as success.
     */
    async function waitForServiceGone(deadline) {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        try {
          await fetch(PREFIX + '/status', { headers: { accept: 'application/json' } });
          /* something answered - keep waiting */
        } catch {
          return true;
        }
      }
      return false;
    }

    /** The sidebar action: one icon button that opens the power dialog. */
    function PowerAction(props) {
      const wide = props.wide === true;
      const t = props.t;
      const [open, setOpen] = React.useState(false);
      const [view, setView] = React.useState('main');
      const [auto, setAuto] = React.useState(null);
      const [autoBusy, setAutoBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [pending, setPending] = React.useState('restart');

      const label = t('action.label');

      React.useEffect(() => {
        if (!open || view !== 'main') return undefined;
        let cancelled = false;
        request('/status', { method: 'GET' })
          .then((result) => {
            if (cancelled) return;
            if (result.body && result.body.autostart) setAuto(result.body.autostart);
            else setAuto({ supported: false, enabled: false, reason: 'tray-not-installed' });
          })
          .catch(() => {
            if (!cancelled) setAuto({ supported: false, enabled: false, reason: 'tray-not-installed' });
          });
        return () => {
          cancelled = true;
        };
      }, [open, view]);

      // Esc and a backdrop click dismiss the dialog only while it is still a plain
      // choice; once an action is running, hiding it would hide its outcome.
      const dismissable = view === 'main' || view === 'confirm-shutdown' || view === 'confirm-restart';

      React.useEffect(() => {
        if (!open || !dismissable) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [open, dismissable]);

      const close = () => {
        setOpen(false);
        setView('main');
        setError(null);
        setNote(null);
      };

      const toggleAutostart = async () => {
        if (auto === null || !auto.supported || autoBusy) return;
        const next = !auto.enabled;
        setAutoBusy(true);
        setError(null);
        try {
          const result = await request(next ? '/autostart/enable' : '/autostart/disable', { method: 'POST' });
          if (result.body && result.body.ok) {
            setAuto(Object.assign({}, auto, { enabled: result.body.enabled === true }));
          } else {
            setError(t('error.prefix') + t('error.' + ((result.body && result.body.error) || 'registry-write-failed')));
          }
        } catch {
          setError(t('error.prefix') + t('error.network'));
        } finally {
          setAutoBusy(false);
        }
      };

      const run = async (action) => {
        setPending(action);
        setView('busy');
        setError(null);
        setNote(null);
        let result;
        try {
          result = await request('/' + action, { method: 'POST' });
        } catch {
          setError(t('error.prefix') + t('error.network'));
          setView('main');
          return;
        }
        if (action === 'restart' && result.body && result.body.ok !== true) {
          setNote(t('no.supervisor'));
          setView('main');
          return;
        }
        if (!result.body || result.body.ok !== true) {
          setError(t('error.prefix') + ((result.body && result.body.error) || ('HTTP ' + result.status)));
          setView('main');
          return;
        }
        if (action === 'shutdown') {
          setView('done-shutdown');
          const gone = await waitForServiceGone(Date.now() + 8000);
          if (!gone) setNote(t('done.shutdown.stillrunning'));
          return;
        }
        setView('done-restart');
        const back = await waitForService(Date.now() + 40000);
        if (back) {
          setNote(t('done.restart.ok'));
          window.location.reload();
        } else {
          setNote(t('done.restart.timeout'));
        }
      };

      const button = h(
        'button',
        {
          type: 'button',
          className: 'dsl-power' + (wide ? '' : ' dsl-power--rail'),
          'aria-label': label,
          title: t('action.tip'),
          onClick: () => setOpen(true),
        },
        h('span', { className: 'dsl-power__glyph' }, h(PowerGlyph, { size: 16 })),
        wide ? h('span', { className: 'dsl-power__label' }, label) : null,
      );

      if (!open) return h(React.Fragment, null, h('style', null, CSS), button);

      const title =
        view === 'confirm-shutdown' ? t('confirm.shutdown.title')
        : view === 'confirm-restart' ? t('confirm.restart.title')
        : t('dialog.title');
      const description =
        view === 'confirm-shutdown' ? t('confirm.shutdown.desc')
        : view === 'confirm-restart' ? t('confirm.restart.desc')
        : t('dialog.desc');

      const body = [];
      if (view !== 'busy' && error !== null) body.push(h('p', { className: 'dsl-note dsl-note--error', key: 'error' }, error));
      if (view !== 'busy' && note !== null) body.push(h('p', { className: 'dsl-note dsl-note--busy', key: 'note' }, note));

      if (view === 'main') {
        body.push(
          h(
            'div',
            { className: 'dsl-actions', key: 'actions' },
            h(
              'button',
              { type: 'button', className: 'dsl-btn dsl-btn--danger', onClick: () => setView('confirm-shutdown') },
              h(PowerGlyph, { size: 14 }),
              t('action.shutdown'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsl-btn', onClick: () => setView('confirm-restart') },
              t('action.restart'),
            ),
          ),
        );
        const supported = auto !== null && auto.supported === true;
        const hint =
          auto === null ? t('autostart.loading')
          : supported ? t('autostart.hint')
          : t('autostart.unsupported');
        body.push(
          h(
            'div',
            { className: 'dsl-row', key: 'autostart' },
            h(
              'div',
              { className: 'dsl-row__text' },
              h('span', { className: 'dsl-row__label' }, t('autostart.label')),
              h('span', { className: 'dsl-row__hint' }, hint),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'dsl-switch',
                'aria-checked': supported && auto.enabled ? 'true' : 'false',
                'aria-label': t('autostart.label'),
                disabled: !supported || autoBusy,
                onClick: toggleAutostart,
              },
              h('span', { className: 'dsl-switch__knob' }),
            ),
          ),
        );
      } else if (view === 'confirm-shutdown' || view === 'confirm-restart') {
        const action = view === 'confirm-shutdown' ? 'shutdown' : 'restart';
        body.push(
          h(
            'div',
            { className: 'dsl-actions', key: 'confirm' },
            h(
              'button',
              {
                type: 'button',
                className: action === 'shutdown' ? 'dsl-btn dsl-btn--danger' : 'dsl-btn',
                onClick: () => run(action),
              },
              t(action === 'shutdown' ? 'confirm.ok.shutdown' : 'confirm.ok.restart'),
            ),
            h('button', { type: 'button', className: 'dsl-btn', onClick: () => setView('main') }, t('action.cancel')),
          ),
        );
      } else if (view === 'busy') {
        body.push(
          h(
            'p',
            { className: 'dsl-note dsl-note--busy', key: 'busy' },
            t(pending === 'shutdown' ? 'busy.shutdown' : 'busy.restart'),
          ),
        );
      } else if (view === 'done-shutdown') {
        body.push(h('p', { className: 'dsl-note dsl-note--ok', key: 'done' }, t('done.shutdown')));
      } else if (view === 'done-restart') {
        body.push(h('p', { className: 'dsl-note dsl-note--busy', key: 'done' }, t('done.restart')));
      }

      const card = h(
        'div',
        { className: 'dsl-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h(
          'div',
          { className: 'dsl-head' },
          h('h2', { className: 'dsl-title' }, title),
          h('button', { type: 'button', className: 'dsl-close', 'aria-label': t('action.close'), onClick: close }, '✕'),
        ),
        h('p', { className: 'dsl-desc' }, description),
        body,
      );

      const overlay = h(
        'div',
        {
          className: 'dsl-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && dismissable) close();
          },
        },
        card,
      );

      const dialog = createPortal !== null ? createPortal(overlay, document.body) : overlay;
      return h(React.Fragment, null, h('style', null, CSS), button, dialog);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ':dictionary');
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-launcher-power', locale: NS, order: 20 },
            PowerAction,
          ),
        );
      },
    };
  },
});
