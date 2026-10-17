/**
 * Client half of the workspace session search bundle.
 *
 * Sidebar-foot "Search sessions" action + frame-wide overlay search palette.
 * One keyword searches both session titles/folders (client list snapshot) and
 * session contents (this plugin's Host route: ranked index when the deployment
 * enables it, otherwise a bounded scan of the session corpus), merged and
 * deduplicated with highlighted snippets. Enter opens the selected session,
 * Esc closes, Up/Down move the selection.
 *
 * Implementation follows the patterns of shipped/working plugins: a plain
 * pub/sub store consumed with useState+useEffect, a position:fixed modal root
 * inside shell.overlay, and host theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@itsyuyi/dsh-workspace-search',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useRef } = React;
    const h = React.createElement;

    const NS = 'workspace-search';
    const ROUTE = '/plugins/dsh-workspace-search/search';
    const NAME_LIMIT = 8;
    const TOTAL_LIMIT = 16;

    const zh = {
      'action.label': '搜索会话',
      'action.aria': '按关键字搜索会话名称或内容',
      'palette.title': '搜索会话',
      'palette.placeholder': '按关键字搜索会话名称或内容…',
      'palette.idle': '输入关键字，同时匹配会话名称与消息内容。',
      'palette.searching': '正在搜索内容…',
      'palette.empty': '未找到匹配的会话',
      'palette.error': '搜索失败，请重试',
      'palette.unavailable': '会话搜索服务当前不可用，请刷新页面后重试。',
      'palette.unavailableList': '会话列表快照当前不可用，请刷新页面后重试。',
      'palette.hint': 'Enter 打开 · Esc 关闭 · ↑↓ 选择',
      'result.name': '名称匹配',
      'result.content': '内容匹配',
      'result.question': '问题匹配',
      'result.reply': '回复匹配',
      'result.untitled': '未命名会话',
      'result.open': '打开会话',
      'result.running': '正在运行',
      'shortcut.label': '打开会话搜索面板',
      'toast.located': '已定位到匹配消息',
      'toast.missed': '已打开会话，未能定位到匹配内容',
    };
    const en = {
      'action.label': 'Search sessions',
      'action.aria': 'Search session titles or contents by keyword',
      'palette.title': 'Search sessions',
      'palette.placeholder': 'Search session titles or contents…',
      'palette.idle': 'Type a keyword to match session titles and message contents.',
      'palette.searching': 'Searching contents…',
      'palette.empty': 'No matching sessions',
      'palette.error': 'Search failed, please retry',
      'palette.unavailable': 'Session search is unavailable right now; refresh the page and retry.',
      'palette.unavailableList': 'The session list snapshot is unavailable right now; refresh the page and retry.',
      'palette.hint': 'Enter open · Esc close · ↑↓ select',
      'result.name': 'Title match',
      'result.content': 'Content match',
      'result.question': 'Question match',
      'result.reply': 'Reply match',
      'result.untitled': 'Untitled session',
      'result.open': 'Open session',
      'result.running': 'Running',
      'shortcut.label': 'Open the session search palette',
      'toast.located': 'Located the matching message',
      'toast.missed': 'Opened the session; could not locate the match',
    };

    /** Plain pub/sub store owned by apply(), mirroring the proven plugin pattern. */
    function createPaletteStore() {
      let state = { open: false, navigation: null };
      let nonce = 0;
      const listeners = new Set();
      const emit = () => {
        for (const fn of listeners) fn();
      };
      return {
        getSnapshot: () => state,
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        open() {
          state = { ...state, open: true };
          emit();
        },
        close() {
          state = { ...state, open: false };
          emit();
        },
        /** Publish where a chosen result points, for the navigator entry to consume. */
        navigate(sessionId, seq, snippet, query) {
          nonce += 1;
          state = { ...state, navigation: { sessionId, seq, snippet, query, nonce } };
          emit();
        },
      };
    }

    /** Session ids reaching a CSS attribute selector must not carry quoting or escapes. */
    const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

    /** Locate one rendered sidebar session row through the workspace browser's row hook. */
    function findSidebarRow(sessionId) {
      if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return null;
      return document.querySelector(`[data-row-key="session:${sessionId}"]`);
    }

    /** Transient visual acknowledgement, removed with the animation. */
    function flash(element) {
      element.classList.add('ws-reveal');
      setTimeout(() => element.classList.remove('ws-reveal'), 1900);
    }

    /**
     * Distinctive slices anchored at the keyword itself: the transcript renders
     * markdown, so windows that start before the keyword may contain syntax the
     * rendered text no longer has. Longest first; the keyword alone is the last
     * resort for multi-character queries.
     */
    function snippetCandidates(snippet, query) {
      const core = String(snippet ?? '').replace(/\s+/g, ' ').trim();
      const needle = String(query ?? '').trim();
      const candidates = [];
      if (needle === '') {
        if (core !== '') candidates.push(core.slice(0, 24));
        return candidates;
      }
      const index = core.toLowerCase().indexOf(needle.toLowerCase());
      if (index >= 0) {
        for (const length of [30, 20, 12]) {
          const candidate = core.slice(index, index + length).trim();
          if (candidate.length >= 2 && !candidates.includes(candidate)) candidates.push(candidate);
        }
        const around = core.slice(Math.max(0, index - 20), index + 20).trim();
        if (around.length > 30 && !candidates.includes(around)) candidates.push(around);
      }
      if (needle.length >= 2 && !candidates.includes(needle)) candidates.push(needle);
      return candidates;
    }

    /** First rendered element whose text carries one of the candidate slices. */
    function locateTranscriptMatch(root, candidates) {
      if (!root || candidates.length === 0) return null;
      const lowered = candidates.map((candidate) => candidate.toLowerCase());
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        if (!text) continue;
        const haystack = text.toLowerCase();
        if (lowered.some((candidate) => haystack.includes(candidate))) {
          return node.parentElement ?? null;
        }
      }
      return null;
    }

    /** Center one element inside the chat scrollport without moving the page. */
    function centerInScrollport(scrollport, element) {
      const box = scrollport.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (rect.top >= box.top && rect.bottom <= box.bottom) return;
      scrollport.scrollTop += (rect.top - box.top) - (box.height - rect.height) / 2;
    }

    function useStoreValue(store) {
      const [value, setValue] = useState(store.getSnapshot);
      useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [store]);
      return value;
    }

    /** Case-insensitive keyword highlighting; returns an array of strings and marks. */
    function highlight(text, query) {
      const q = String(query ?? '').trim();
      if (!q) return [text];
      const lower = text.toLowerCase();
      const ql = q.toLowerCase();
      const parts = [];
      let cursor = 0;
      let key = 0;
      while (true) {
        const index = lower.indexOf(ql, cursor);
        if (index < 0) {
          parts.push(text.slice(cursor));
          break;
        }
        if (index > cursor) parts.push(text.slice(cursor, index));
        parts.push(h('mark', { key: `m${key++}` }, text.slice(index, index + q.length)));
        cursor = index + q.length;
      }
      return parts;
    }

    function basenameOf(path) {
      if (typeof path !== 'string' || path === '') return '';
      return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
    }

    function MagnifierIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        'aria-hidden': true,
      }, h('circle', { cx: 7, cy: 7, r: 4.5 }),
        h('line', { x1: 10.4, y1: 10.4, x2: 14, y2: 14 }));
    }

    const FOOTER_ACTION_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      height: '28px',
      padding: '0 10px',
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      fontSize: '13px',
      lineHeight: '28px',
    };

    const PALETTE_CSS = [
      '.ws-modalRoot{position:fixed;inset:0;z-index:1000;display:flex;',
      'justify-content:center;align-items:flex-start;padding-top:12vh;}',
      '.ws-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4));',
      'backdrop-filter:var(--dsw-mask-blur,none);}',
      '.ws-panel{position:relative;z-index:1;display:flex;flex-direction:column;',
      'width:620px;max-width:calc(100vw - 48px);max-height:70vh;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay));',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:12px;',
      'box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.28));}',
      '.ws-inputrow{display:flex;align-items:center;gap:8px;padding:10px 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
      '.ws-input{flex:1;min-width:0;border:none;outline:none;background:transparent;',
      'color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;',
      'font-family:inherit;}',
      '.ws-input::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.ws-body{overflow-y:auto;padding:6px;min-height:0;}',
      '.ws-state{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-secondary);',
      'font-size:13px;line-height:1.6;}',
      '.ws-error{color:var(--dsw-alias-state-error-primary);}',
      '.ws-code{margin-top:4px;font-size:11px;opacity:.7;}',
      '.ws-row{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;',
      'border:none;background:transparent;color:var(--dsw-alias-label-primary);',
      'border-radius:8px;padding:8px 10px;cursor:pointer;font-family:inherit;}',
      '.ws-row:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.ws-row-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}',
      '.ws-row-selected:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);}',
      '.ws-row-head{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.ws-row-title{flex:1;min-width:0;font-size:13px;font-weight:500;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ws-row-tag{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
      '.ws-row-dot{flex:none;width:7px;height:7px;border-radius:50%;',
      'background:var(--dsw-alias-state-success-primary);}',
      '.ws-row-ws{font-size:12px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ws-row-snippet{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.ws-row mark{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);',
      'color:var(--dsw-alias-label-primary);border-radius:3px;padding:0 1px;}',
      '.ws-hint{padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);',
      'font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '@keyframes ws-reveal-pulse{0%{background-color:color-mix(in srgb,',
      'var(--dsw-alias-brand-primary) 26%,transparent);}100%{background-color:transparent;}}',
      '.ws-reveal{animation:ws-reveal-pulse 1.8s ease-out;border-radius:8px;}',
      '.ws-toast{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2000;',
      'background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay));',
      'color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:10px;padding:8px 14px;font-size:13px;line-height:18px;',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.25));pointer-events:none;}',
    ].join('\n');

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        let t;
        try {
          const locale = ctx.get('locale');
          if (locale && typeof locale.register === 'function') {
            locale.register(NS, { zh, en });
          }
          t = locale && typeof locale.bind === 'function'
            ? locale.bind(NS)
            : (key) => en[key] ?? key;
        } catch (error) {
          t = (key) => en[key] ?? key;
        }

        // Declared-inject services resolve through the loader's fiber chain,
        // exactly like the shipped UI modules consume them.
        let sessions;
        let uiWorkspace;
        try {
          sessions = ctx.sessions;
        } catch (error) {
          sessions = ctx.get('sessions');
        }
        try {
          uiWorkspace = ctx.uiWorkspace;
        } catch (error) {
          uiWorkspace = ctx.get('uiWorkspace');
        }
        if (!sessions || !uiWorkspace || !sessions.list) {
          console.error('[workspace-search] service resolution:', {
            sessions: Boolean(sessions),
            sessionsList: Boolean(sessions && sessions.list),
            uiWorkspace: Boolean(uiWorkspace),
          });
        }
        const store = createPaletteStore();

        function FooterAction(props) {
          const wide = props.wide;
          return h('button', {
            type: 'button',
            style: FOOTER_ACTION_STYLE,
            title: t('action.label'),
            'aria-label': t('action.aria'),
            onClick: () => store.open(),
          },
            h(MagnifierIcon, { size: 16 }),
            wide ? h('span', null, t('action.label')) : null);
        }

        function Palette() {
          const open = useStoreValue(store).open;
          const [query, setQuery] = useState('');
          const [content, setContent] = useState(null); // { items } | { error } | null
          const [pending, setPending] = useState(false);
          const [selected, setSelected] = useState(0);
          const [listSnapshot, setListSnapshot] = useState(() => {
            try {
              return sessions && sessions.list ? sessions.list.getSnapshot() : null;
            } catch (error) {
              console.error('[workspace-search] sessions.list unavailable:', error);
              return null;
            }
          });
          const inputRef = useRef(null);
          const abortRef = useRef(null);
          const bodyRef = useRef(null);
          const q = query.trim();

          // Keep the selected row visible while navigating with the arrows.
          useEffect(() => {
            const body = bodyRef.current;
            if (!body) return;
            const el = body.querySelector('.ws-row-selected');
            if (el) el.scrollIntoView({ block: 'nearest' });
          }, [selected]);

          // Keep the live list snapshot subscribed while the palette exists.
          useEffect(() => {
            if (!sessions || !sessions.list) return undefined;
            try {
              const stop = sessions.list.subscribe(() => {
                setListSnapshot(sessions.list.getSnapshot());
              });
              return stop;
            } catch (error) {
              console.error('[workspace-search] sessions.list.subscribe failed:', error);
              return undefined;
            }
          }, []);

          // Reset on open; abort the in-flight content search on close.
          useEffect(() => {
            if (open) {
              setQuery('');
              setContent(null);
              setSelected(0);
              const timer = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
              return () => clearTimeout(timer);
            }
            if (abortRef.current) abortRef.current.abort();
            return undefined;
          }, [open]);

          // Abort any in-flight content search when the entry unmounts.
          useEffect(() => () => {
            if (abortRef.current) abortRef.current.abort();
          }, []);

          // Debounced Host content search, cancelling superseded queries.
          useEffect(() => {
            if (!open || !q) {
              if (abortRef.current) abortRef.current.abort();
              abortRef.current = null;
              setContent(null);
              setPending(false);
              return undefined;
            }
            setPending(true);
            const controller = new AbortController();
            if (abortRef.current) abortRef.current.abort();
            abortRef.current = controller;
            const timer = setTimeout(async () => {
              try {
                const response = await fetch(ROUTE, {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ query: q }),
                  signal: controller.signal,
                });
                const body = await response.json().catch(() => null);
                if (controller.signal.aborted) return;
                if (response.ok && body && body.ok === true) {
                  setContent({ items: Array.isArray(body.items) ? body.items : [] });
                } else {
                  setContent({ error: (body && body.error) || `http-${response.status}` });
                }
              } catch (error) {
                if (controller.signal.aborted) return;
                console.error('[workspace-search] content search failed:', error);
                setContent({ error: 'request-failed' });
              } finally {
                if (!controller.signal.aborted) setPending(false);
              }
            }, 200);
            return () => clearTimeout(timer);
          }, [q, open]);

          if (!open) return null;

          // Derive the merged result rows; any failure here becomes a visible error.
          let rows = [];
          let renderError = null;
          try {
            const byId = listSnapshot && listSnapshot.byId ? listSnapshot.byId : {};
            const entries = Object.values(byId);
            const ql = q.toLowerCase();
            const titleOf = (entry) => {
              if (entry && typeof entry.title === 'string' && entry.title.trim() !== '') {
                return entry.title;
              }
              const fallback = basenameOf(entry && entry.cwd);
              return fallback || t('result.untitled');
            };
            const nameMatches = q
              ? entries
                .filter((entry) => entry
                  && !entry.blank
                  && ((typeof entry.title === 'string' && entry.title.toLowerCase().includes(ql))
                    || basenameOf(entry.cwd).toLowerCase().includes(ql)))
                .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                .slice(0, NAME_LIMIT)
              : [];
            const seen = new Set();
            for (const entry of nameMatches) {
              seen.add(entry.id);
              rows.push({
                sessionId: entry.id,
                title: titleOf(entry),
                workspace: basenameOf(entry.cwd),
                kind: 'name',
                running: entry.running === true,
              });
            }
            if (content && Array.isArray(content.items)) {
              for (const item of content.items) {
                if (!item || typeof item.sessionId !== 'string' || seen.has(item.sessionId)) continue;
                if (rows.length >= TOTAL_LIMIT) break;
                seen.add(item.sessionId);
                const entry = byId[item.sessionId];
                const hostTitle = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : '';
                rows.push({
                  sessionId: item.sessionId,
                  title: hostTitle || titleOf(entry),
                  workspace: basenameOf((entry && entry.cwd) || item.cwd),
                  kind: 'content',
                  snippet: typeof item.snippet === 'string' ? item.snippet : '',
                  seq: typeof item.seq === 'number' ? item.seq : null,
                  eventType: typeof item.eventType === 'string' ? item.eventType : null,
                  running: entry && entry.running === true,
                });
              }
            }
          } catch (error) {
            console.error('[workspace-search] result derivation failed:', error);
            renderError = error;
          }

          const unavailable = !sessions || !sessions.list;
          const unavailableKey = !sessions ? 'palette.unavailable' : 'palette.unavailableList';
          const openRow = (row) => {
            if (uiWorkspace) uiWorkspace.openSession(row.sessionId);
            // Hand the target coordinates to the navigator: the sidebar row and,
            // for a content hit, the exact event the keyword was found in.
            store.navigate(
              row.sessionId,
              typeof row.seq === 'number' ? row.seq : null,
              row.kind === 'content' ? row.snippet : '',
              q,
            );
            store.close();
          };
          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              store.close();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected((current) => (rows.length ? (current + 1) % rows.length : 0));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((current) => (rows.length ? (current - 1 + rows.length) % rows.length : 0));
            } else if (event.key === 'Enter') {
              const row = rows[selected] ?? rows[0];
              if (row) openRow(row);
            }
          };

          const searching = pending && !content;
          const searchFailed = Boolean(content && content.error);
          const failureCode = searchFailed ? String(content.error) : '';
          return h('div', { className: 'ws-modalRoot', role: 'presentation' },
            h('div', { className: 'ws-mask', 'aria-hidden': 'true', onClick: () => store.close() }),
            h('div', {
              className: 'ws-panel',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('palette.title'),
            },
              h('div', { className: 'ws-inputrow' },
                h(MagnifierIcon, { size: 16 }),
                h('input', {
                  ref: inputRef,
                  className: 'ws-input',
                  value: query,
                  placeholder: t('palette.placeholder'),
                  spellCheck: false,
                  autoComplete: 'off',
                  'aria-label': t('palette.title'),
                  onChange: (event) => {
                    setQuery(event.target.value);
                    setSelected(0);
                  },
                  onKeyDown,
                })),
              h('div', { className: 'ws-body', role: 'listbox', 'aria-label': t('palette.title'), ref: bodyRef },
                unavailable
                  && h('div', { className: 'ws-state ws-error' }, t(unavailableKey)),
                !unavailable && renderError
                  && h('div', { className: 'ws-state ws-error' }, t('palette.error')),
                !unavailable && !renderError && !q
                  && h('div', { className: 'ws-state' }, t('palette.idle')),
                !unavailable && !renderError && q && rows.length === 0 && !searching && !searchFailed
                  && h('div', { className: 'ws-state' }, t('palette.empty')),
                !unavailable && !renderError && q && rows.length === 0 && searching
                  && h('div', { className: 'ws-state' }, t('palette.searching')),
                !unavailable && !renderError && searchFailed
                  && h('div', { className: 'ws-state ws-error' },
                    t('palette.error'),
                    failureCode ? h('div', { className: 'ws-code' }, failureCode) : null),
                rows.map((row, index) => h('button', {
                  key: `${row.kind}:${row.sessionId}`,
                  type: 'button',
                  role: 'option',
                  'aria-selected': index === selected,
                  className: `ws-row${index === selected ? ' ws-row-selected' : ''}`,
                  'aria-label': `${t('result.open')}: ${row.title}`,
                  onMouseEnter: () => setSelected(index),
                  onClick: () => openRow(row),
                },
                  h('span', { className: 'ws-row-head' },
                    h('span', { className: 'ws-row-title' }, highlight(row.title, q)),
                    h('span', { className: 'ws-row-tag' },
                      row.kind === 'name'
                        ? t('result.name')
                        : row.eventType === 'user/message'
                          ? t('result.question')
                          : row.eventType === 'assistant/message'
                            ? t('result.reply')
                            : t('result.content')),
                    row.running ? h('span', {
                      className: 'ws-row-dot',
                      title: t('result.running'),
                    }) : null),
                  row.workspace ? h('span', { className: 'ws-row-ws' }, row.workspace) : null,
                  row.snippet ? h('span', { className: 'ws-row-snippet' }, highlight(row.snippet, q)) : null))),
              h('div', { className: 'ws-hint' }, t('palette.hint'))));
        }

        /**
         * Consumes one navigation request: reveal the sidebar row (expanding its
         * collapsed workspace group when necessary), and for a content hit load
         * history through its event and center the matched text. Every step
         * retries (the surfaces re-render asynchronously) and degrades gracefully:
         * opening the session has already succeeded by this point.
         */
        function Navigator(props) {
          const navigation = useStoreValue(store).navigation;
          const workspaces = props.useWorkspaces
            ? props.useWorkspaces((snapshot) => snapshot.items)
            : null;
          const [notice, setNotice] = useState(null);

          useEffect(() => {
            if (!navigation) return undefined;
            let cancelled = false;
            const timers = new Set();
            const later = (fn, delay) => {
              const timer = setTimeout(() => {
                timers.delete(timer);
                if (!cancelled) fn();
              }, delay);
              timers.add(timer);
            };
            const toast = (text, delay = 2600) => {
              if (cancelled) return;
              setNotice(text);
              later(() => setNotice((current) => current === text ? null : current), delay);
            };

            // 1. The sidebar row: poll first (the list may still re-render), then
            //    expand the owning workspace group, then its overflow slice.
            let pollAttempts = 0;
            let expanded = false;
            const scrollRow = () => {
              const row = findSidebarRow(navigation.sessionId);
              if (row) {
                row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                flash(row);
                return;
              }
              if (pollAttempts >= 8 && !expanded) {
                expanded = true;
                expandOwningGroup();
                return;
              }
              if (pollAttempts < 30) {
                pollAttempts += 1;
                later(scrollRow, 120);
              }
            };
            const expandOwningGroup = () => {
              const owner = Array.isArray(workspaces)
                ? workspaces.find((workspace) => Array.isArray(workspace.sessionIds)
                    && workspace.sessionIds.includes(navigation.sessionId))
                : undefined;
              const key = owner && typeof owner.workspaceId === 'string' && SAFE_ID.test(owner.workspaceId)
                ? owner.workspaceId
                : '';
              const header = document.querySelector(`[data-row-key="workspace:${key}"]`);
              if (!header) return;
              if (header.getAttribute('aria-expanded') !== 'true') {
                console.error('[workspace-search] expanding sidebar group', key);
                header.click();
              } else {
                const overflow = document.querySelector(`[data-row-key="overflow:${key}"]`);
                if (overflow && overflow.getAttribute('aria-expanded') !== 'true') {
                  console.error('[workspace-search] expanding overflow slice', key);
                  overflow.click();
                }
              }
            };
            console.error('[workspace-search] reveal', navigation.sessionId, navigation.seq);
            scrollRow();

            // 2. The matched message: load through its seq, then locate its text.
            if (typeof navigation.seq === 'number' && navigation.seq >= 0) {
              const candidates = snippetCandidates(navigation.snippet, navigation.query);
              let bindingAttempts = 0;
              const awaitBinding = () => {
                let binding;
                try {
                  binding = sessions && sessions.binding ? sessions.binding(navigation.sessionId) : undefined;
                } catch (error) {
                  binding = undefined;
                }
                if (!binding) {
                  if (bindingAttempts < 60) {
                    bindingAttempts += 1;
                    later(awaitBinding, 100);
                  } else {
                    toast(t('toast.missed'));
                  }
                  return;
                }
                Promise.resolve()
                  .then(() => binding.session.loadThrough(navigation.seq))
                  .catch((error) => console.error('[workspace-search] loadThrough failed:', error))
                  .then(() => {
                    if (cancelled) return;
                    let scrollAttempts = 0;
                    const scrollToMatch = () => {
                      // Scope to this Session's conversation, and scroll its own
                      // scrollport (`data-conversation-scroll`), not the region.
                      const scope = SAFE_ID.test(navigation.sessionId)
                        ? document.querySelector(`[data-conversation-session="${navigation.sessionId}"]`)
                        : null;
                      const scrollport = scope
                        ? scope.querySelector('[data-conversation-scroll]')
                        : document.querySelector('[data-conversation-scroll]');
                      const match = scrollport ? locateTranscriptMatch(scrollport, candidates) : null;
                      if (scrollport && match) {
                        centerInScrollport(scrollport, match);
                        flash(match);
                        console.error('[workspace-search] transcript match located');
                        toast(t('toast.located'));
                        return;
                      }
                      if (scrollAttempts < 40) {
                        scrollAttempts += 1;
                        later(scrollToMatch, 200);
                      } else {
                        console.error('[workspace-search] transcript match not found; candidates:', candidates);
                        toast(t('toast.missed'));
                      }
                    };
                    scrollToMatch();
                  });
              };
              later(awaitBinding, 150);
            }

            return () => {
              cancelled = true;
              for (const timer of timers) clearTimeout(timer);
              timers.clear();
            };
          }, [navigation]);

          if (!notice) return null;
          return h('div', { className: 'ws-toast', role: 'status' }, notice);
        }

        // One stylesheet for both entries, removed on unload (proven pattern).
        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head) return () => {};
          const el = document.createElement('style');
          el.setAttribute('data-dsh-workspace-search', '');
          el.textContent = PALETTE_CSS;
          document.head.appendChild(el);
          return () => {
            el.remove();
          };
        }, 'workspace-search: styles');

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'workspace-search',
          order: 0,
          label: () => t('action.label'),
        }, (props) => h(FooterAction, { wide: props.wide })));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-search',
          order: 100,
        }, () => h(Palette)));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-search.navigator',
          order: 101,
        }, (props) => h(Navigator, props)));

        try {
          const shortcuts = ctx.get('shortcuts');
          if (shortcuts) {
            ctx.effect(() => shortcuts.register({
              id: 'workspace-search.palette',
              label: () => t('shortcut.label'),
              aliases: ['search sessions palette'],
              defaults: {
                'desktop:macos': { code: 'KeyK', modifiers: ['primary', 'shift'] },
                'desktop:windows': { code: 'KeyK', modifiers: ['primary', 'shift'] },
                'desktop:linux': { code: 'KeyK', modifiers: ['primary', 'shift'] },
                'web:macos': { code: 'KeyK', modifiers: ['primary', 'alt', 'shift'] },
                'web:windows': { code: 'KeyK', modifiers: ['primary', 'alt', 'shift'] },
              },
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => ({ status: 'handled', run: () => store.open() }),
            }), 'workspace-search: shortcut');
          }
        } catch (error) {
          console.error('[workspace-search] shortcut registration failed:', error);
        }
      },
    };
  },
});
