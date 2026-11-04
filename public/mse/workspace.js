(function () {
  'use strict';
  var KEY = 'mse.workspace.v1';
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function write(node, text) { if (node && node.textContent !== String(text)) node.textContent = String(text); }
  function button(text, action, className) {
    var b = element('button', className || 'workspace-segment', text); b.type = 'button'; b.addEventListener('click', action); return b;
  }
  window.initMSEWorkspace = function (api) {
    if (document.body.classList.contains('mse-workspace')) return;
    var view = { focus: true, preview: 'current' }, sectionList = api.sections(), currentStatus = api.workspaceStatus();
    var focusButtons = [], previewButtons = [], storageFailed = false;
    var detailSource = null, detailObserver = null, composing = false, panelMemory = new WeakMap();
    try {
      var raw = localStorage.getItem(KEY);
      if (raw && raw.length <= 200) {
        var stored = JSON.parse(raw);
        if (stored && stored.version === 1 && typeof stored.focus === 'boolean' && ['current', 'all'].indexOf(stored.preview) !== -1) {
          view.focus = stored.focus; view.preview = stored.preview;
        }
      }
    } catch (_) { /* An unavailable preference store must not block clinical input. */ }
    document.body.classList.add('mse-workspace');
    function persist() {
      try { localStorage.setItem(KEY, JSON.stringify({ version: 1, focus: view.focus, preview: view.preview })); }
      catch (_) {
        if (!storageFailed && api.notify) api.notify('화면 설정을 저장하지 못해 이번 실행에서만 유지합니다.');
        storageFailed = true;
      }
    }
    function choose(kind, value) {
      if (view[kind] === value) return;
      view[kind] = value; persist(); applySelection(); api.setView({ focus: view.focus, preview: view.preview });
    }
    function segments(kind, choices, label) {
      var group = element('div', 'workspace-segments'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
      choices.forEach(function (choice) {
        var b = button(choice[1], function () { choose(kind, choice[0]); }); b.dataset.viewValue = String(choice[0]);
        b.setAttribute('aria-pressed', String(view[kind] === choice[0])); group.appendChild(b);
        (kind === 'focus' ? focusButtons : previewButtons).push(b);
      });
      return group;
    }
    function applySelection() {
      document.body.classList.toggle('workspace-focus', view.focus);
      document.body.classList.toggle('workspace-preview-current', view.preview === 'current');
      focusButtons = focusButtons.filter(function (b) { return b.isConnected; });
      previewButtons = previewButtons.filter(function (b) { return b.isConnected; });
      focusButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.viewValue === String(view.focus))); });
      previewButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.viewValue === view.preview)); });
    }
    function mountHeader() {
      var top = document.querySelector('.top'); if (!top) return;
      if (!top.querySelector('.workspace-brand')) {
        var brand = element('div', 'workspace-brand'), symbol = element('div', 'workspace-symbol', 'MSE'); symbol.setAttribute('aria-hidden', 'true');
        var words = element('div', 'workspace-brand-words');
        var title = top.querySelector('h1');
        if (title) words.appendChild(title);
        brand.appendChild(symbol); brand.appendChild(words); top.insertBefore(brand, top.firstChild);
      }
      var tools = document.getElementById('mseProductivityToolbar');
      if (tools && tools.parentElement !== top) top.appendChild(tools);
      var fonts = top.querySelector('.fontctl'); if (fonts && tools && fonts.parentElement !== tools) tools.appendChild(fonts);
      var transfer = document.querySelector('.rfoot .primary');
      if (transfer) { transfer.id = 'workspaceTransfer'; transfer.classList.add('workspace-transfer'); top.appendChild(transfer); }
      var footer = document.getElementById('workspaceStatusBar');
      if (!footer) { footer = element('footer', 'workspace-statusbar'); footer.id = 'workspaceStatusBar'; footer.setAttribute('aria-label', '입력 이력 및 초안 보관'); document.querySelector('.layout').insertAdjacentElement('afterend', footer); }
      var session = document.getElementById('sessionBar'); if (session && session.parentElement !== footer) footer.appendChild(session);
    }
    function mountNavigation() {
      var nav = document.querySelector('nav.toc'); if (!nav) return;
      var heading = nav.querySelector('.workspace-nav-head');
      if (!heading) {
        heading = element('div', 'workspace-nav-head');
        heading.appendChild(element('h2', '', 'MSE 영역'));
        var summary = element('div', 'workspace-progress-summary'); summary.appendChild(element('span', '', '확인한 영역'));
        var count = element('strong'); count.id = 'workspaceConfirmed'; summary.appendChild(count); heading.appendChild(summary); nav.insertBefore(heading, nav.firstChild);
      }
      var progress = document.querySelector('.rhead .review-progress'); if (progress) heading.appendChild(progress);
      sectionList.forEach(function (sec, index) {
        var link = document.getElementById('toc-' + sec.id); if (!link || link.querySelector('.workspace-nav-label')) return;
        // Keep the existing link, listener and .tick used by the core confirmation code.
        Array.from(link.childNodes).forEach(function (node) { if (node.nodeType === 3) link.removeChild(node); });
        var number = element('span', 'workspace-nav-number', String(index + 1).padStart(2, '0')); number.setAttribute('aria-hidden', 'true');
        var text = element('span', 'workspace-nav-text'); text.appendChild(element('span', 'workspace-nav-label', sec.label));
        var state = element('span', 'workspace-nav-state', '미확인'); text.appendChild(state);
        link.appendChild(number); link.appendChild(text);
      });
      var controls = document.querySelector('.rhead .rhead-actions') || document.querySelector('.workspace-nav-tools');
      if (controls) {
        controls.classList.add('workspace-nav-tools');
        var toolsHost = window.innerWidth <= 850 ? document.getElementById('workspaceStatusBar') : nav;
        if (toolsHost && controls.parentElement !== toolsHost) toolsHost.appendChild(controls);
        if (api.nextAttention && !controls.querySelector('#workspaceNextAttention')) {
          var originalNext = controls.querySelector('button'); if (originalNext) originalNext.hidden = true;
          var next = button('다음 검토 영역', function () { api.nextAttention(); }, 'tbtn'); next.id = 'workspaceNextAttention';
          controls.insertBefore(next, controls.firstChild);
        }
      }
    }
    function mountInput() {
      var form = document.getElementById('formArea');
      if (form && !document.getElementById('workspaceInputPane')) {
        var pane = element('div', 'workspace-input-pane'); pane.id = 'workspaceInputPane';
        form.parentElement.insertBefore(pane, form); pane.appendChild(form);
        var foot = element('div', 'workspace-input-footer'); foot.id = 'workspaceInputFooter'; foot.setAttribute('aria-label', '현재 영역 확인');
        var context = element('span', 'workspace-confirm-context'); context.id = 'workspaceConfirmContext'; foot.appendChild(context);
        var confirm = button('현재 영역 확인', function () { if (api.confirmCurrent) api.confirmCurrent(false); }, 'tbtn workspace-confirm-current'); confirm.id = 'workspaceConfirmCurrent';
        var next = button('확인 후 다음', function () { if (api.confirmCurrent) api.confirmCurrent(true); }, 'tbtn primary workspace-confirm-next'); next.id = 'workspaceConfirmNext';
        foot.appendChild(confirm); foot.appendChild(next);
        var hint = element('span', 'workspace-panel-hint', 'F6 영역 이동'); hint.title = 'F6: 목차 → 입력 → 결과 · Shift+F6: 이전 영역'; foot.appendChild(hint); pane.appendChild(foot);
        form.setAttribute('aria-label', '면담 입력');
      }
      var bar = document.querySelector('.formbar');
      if (bar && !bar.querySelector('.workspace-input-label')) {
        var label = element('span', 'workspace-input-label', '면담 입력'); bar.insertBefore(label, bar.firstChild);
        label.insertAdjacentElement('afterend', segments('focus', [[true, '현재 영역'], [false, '전체 영역']], '입력 영역 보기'));
      }
      sectionList.forEach(function (sec, index) {
        var heading = document.querySelector('#sec-' + sec.id + ' > h2'); if (!heading || heading.querySelector('.workspace-section-name')) return;
        var first = Array.from(heading.childNodes).find(function (n) { return n.nodeType === 3 && n.textContent.trim(); }); if (!first) return;
        var raw = first.textContent, match = raw.match(/^\s*\d+\)\s*(.*?)\s*\(([^()]*)\)\s*$/);
        var number = element('span', 'workspace-section-number', String(index + 1).padStart(2, '0')); number.setAttribute('aria-hidden', 'true');
        var name = element('span', 'workspace-section-name'); name.appendChild(element('span', 'workspace-section-korean', match ? match[1] : sec.label));
        if (match) name.appendChild(element('span', 'workspace-section-english', match[2]));
        heading.insertBefore(number, first); heading.insertBefore(name, first); heading.removeChild(first);
      });
      var appearance = document.getElementById('sec-appearance');
      if (appearance) {
        var date = appearance.querySelector('[data-gid="interview_date"][data-prefix="appearance"]');
        var mode = appearance.querySelector('[data-gid="contact_mode"][data-prefix="appearance"]');
        if (date && mode && !appearance.querySelector('.workspace-interview-meta')) {
          var meta = element('div', 'workspace-interview-meta'); meta.setAttribute('role', 'group'); meta.setAttribute('aria-label', '면담 기본 정보');
          date.parentElement.insertBefore(meta, date); meta.appendChild(date); meta.appendChild(mode);
        }
      }
    }
    function mountResults() {
      var head = document.querySelector('.rhead'); if (!head || head.querySelector('.workspace-result-heading')) return;
      var heading = element('div', 'workspace-result-heading');
      heading.appendChild(element('span', 'workspace-eyebrow', '작성 결과'));
      var title = element('h2'); title.id = 'workspaceResultTitle'; heading.appendChild(title);
      var status = element('div', 'workspace-result-status'); status.id = 'workspaceResultStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); heading.appendChild(status);
      heading.appendChild(segments('preview', [['current', '현재 영역'], ['all', '전체 결과']], '작성 결과 보기'));
      if (api.openSelectionReview) {
        var selected = button('선택 내용 확인', function () { api.openSelectionReview(); }, 'tbtn workspace-selection-review'); selected.id = 'workspaceSelectionReview'; heading.appendChild(selected);
      }
      head.insertBefore(heading, head.firstChild);
    }
    function syncAppearanceOptions() {
      var card = document.getElementById('result-appearance');
      var source = document.getElementById('field-appearance-detail_level');
      if (!card || !source) return;
      var host = card.querySelector('.workspace-output-format');
      if (!host) {
        host = element('div', 'workspace-output-format'); host.id = 'workspaceAppearanceFormat';
        host.setAttribute('role', 'group'); host.setAttribute('aria-label', '외관 문단 길이');
        host.appendChild(element('span', 'workspace-output-format-label', '문단 길이'));
        var choices = element('div', 'workspace-segments'); host.appendChild(choices);
        ['full', 'brief'].forEach(function (value) {
          var b = button(value === 'full' ? '자세히' : '간단히', function () {
            var actual = document.getElementById('field-appearance-detail_level--' + value);
            if (actual && !actual.disabled && sourceVisible()) { actual.click(); syncAppearanceOptions(); }
          }, 'workspace-segment workspace-output-choice'); b.dataset.detailValue = value; b.id = 'workspaceDetail-' + value; choices.appendChild(b);
        });
        var help = button('i', function () {
          var original = document.querySelector('#field-appearance-detail_level > .lab .ibtn'); if (original) original.click();
        }, 'ibtn'); help.setAttribute('aria-label', '외관 문단 길이 설명'); help.title = '외관 문단 길이 설명'; host.appendChild(help);
        var alerts = card.querySelector('.card-alerts'); if (alerts) card.insertBefore(host, alerts); else card.appendChild(host);
      }
      if (detailSource !== source) {
        if (detailObserver) detailObserver.disconnect(); detailSource = source;
        source.classList.add('workspace-format-source');
        if (window.MutationObserver) {
          detailObserver = new MutationObserver(syncAppearanceOptions);
          detailObserver.observe(source, { attributes: true, subtree: true, attributeFilter: ['hidden', 'aria-pressed'] });
        }
      }
      if (host.hidden !== source.hidden) host.hidden = source.hidden;
      ['full', 'brief'].forEach(function (value) {
        var actual = document.getElementById('field-appearance-detail_level--' + value), proxy = document.getElementById('workspaceDetail-' + value);
        if (!actual || !proxy) return;
        var pressed = actual.getAttribute('aria-pressed') === 'true' ? 'true' : 'false';
        if (proxy.getAttribute('aria-pressed') !== pressed) proxy.setAttribute('aria-pressed', pressed);
        if (proxy.disabled !== actual.disabled) proxy.disabled = actual.disabled;
      });
    }
    function sourceVisible() {
      var source = document.getElementById('field-appearance-detail_level'); return !!source && !source.hidden;
    }
    function focusDetailOption(id) {
      api.goSection('appearance'); syncAppearanceOptions();
      if (!sourceVisible()) { if (api.notify) api.notify('전화·사이버 면담에서는 외관 문단 길이를 변경하지 않습니다.'); return true; }
      // Section navigation can fold the preview in a narrow window. Reveal it before focusing its controls.
      if (api.showResult) api.showResult('appearance');
      var wanted = String(id || '').split('--')[1], target = document.getElementById('workspaceDetail-' + (wanted === 'brief' ? 'brief' : 'full'));
      if (!target) return false;
      target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true }); return true;
    }
    function visible(node) {
      if (!node || !node.isConnected || node.disabled) return false;
      for (var cur = node; cur && cur.nodeType === 1; cur = cur.parentElement) {
        if (cur.hidden || cur.hasAttribute('inert')) return false;
        var style = getComputedStyle(cur); if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    }
    function panels() {
      var nav = document.querySelector('nav.toc'), select = document.querySelector('.tocsel');
      return [visible(nav) ? nav : select, document.getElementById('formArea'), document.getElementById('resultArea')].filter(visible);
    }
    document.addEventListener('compositionstart', function () { composing = true; }, true);
    document.addEventListener('compositionend', function () { composing = false; }, true);
    document.addEventListener('focusin', function (e) {
      var target = e.target, pane = target && target.closest ? target.closest('nav.toc, .tocsel, #formArea, #resultArea') : null;
      // Focus has already arrived here; defer visibility/style reads until an actual F6 navigation.
      if (pane && pane !== target) panelMemory.set(pane, target);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'F6' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || composing || document.querySelector('dialog[open]')) return;
      var list = panels(); if (!list.length) return;
      var active = document.activeElement, inputPane = document.getElementById('workspaceInputPane');
      var from = list.findIndex(function (pane) { return pane === active || pane.contains(active) || (pane.id === 'formArea' && inputPane && inputPane.contains(active)); });
      var next = from < 0 ? (e.shiftKey ? list.length - 1 : 0) : (from + (e.shiftKey ? -1 : 1) + list.length) % list.length;
      var pane = list[next], remembered = panelMemory.get(pane);
      if (!visible(remembered)) remembered = null;
      e.preventDefault();
      if (remembered) remembered.focus({ preventScroll: true });
      else { pane.tabIndex = -1; pane.focus({ preventScroll: true }); }
    });
    function countMissing(value) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : value ? 1 : 0; }
    function update(status, preserveInitialView) {
      if (status && Array.isArray(status.sections)) currentStatus = status;
      if (!preserveInitialView && status) {
        if (typeof status.focus === 'boolean') view.focus = status.focus;
        if (status.preview === 'current' || status.preview === 'all') view.preview = status.preview;
      }
      mountHeader(); mountNavigation(); mountInput(); mountResults(); syncAppearanceOptions(); applySelection();
      var data = currentStatus || {}, current = (data.sections || []).find(function (sec) { return sec.id === data.current; });
      write(document.getElementById('workspaceConfirmed'), (Number(data.confirmed) || 0) + ' / ' + (Number(data.total) || sectionList.length));
      write(document.getElementById('workspaceResultTitle'), view.preview === 'all' ? '전체 MSE 문장' : current ? current.label : '현재 영역의 문장');
      write(document.getElementById('workspaceConfirmContext'), current ? current.label : '현재 영역');
      var confirm = document.getElementById('workspaceConfirmCurrent'), next = document.getElementById('workspaceConfirmNext');
      if (confirm) { confirm.disabled = !current || !api.confirmCurrent; write(confirm, current && current.confirmed ? '영역 확인 완료' : '현재 영역 확인'); confirm.classList.toggle('is-confirmed', !!current && current.confirmed); }
      if (next) { next.disabled = !current || !api.confirmCurrent; write(next, current && sectionList[sectionList.length - 1].id === current.id ? '확인 후 결과 보기' : '확인 후 다음'); }
      var resultStatus = document.getElementById('workspaceResultStatus');
      if (resultStatus) {
        var scope = view.preview === 'all' ? data.sections || [] : current ? [current] : [], missing = scope.reduce(function (sum, s) { return sum + countMissing(s.missing); }, 0);
        var stale = scope.some(function (s) { return s.stale; }), edited = scope.some(function (s) { return s.edited; }), alerts = scope.some(function (s) { return s.alerts; });
        var done = scope.length > 0 && scope.every(function (s) { return s.confirmed; });
        var base = done ? '영역 확인 완료' : '확인 전 초안';
        var label = stale ? '직접 수정 문장 재검토' : missing ? base + ' · 입력 ' + missing + '곳 필요' : alerts ? base + ' · 검토할 내용 있음' : base;
        resultStatus.dataset.state = stale || missing || alerts ? 'attention' : done ? 'confirmed' : 'draft';
        var example = data.example ? 'true' : 'false';
        if (resultStatus.dataset.example !== example) resultStatus.dataset.example = example;
        write(resultStatus, (data.example ? '가상 예시 · ' : '') + label + (edited && !stale ? ' · 직접 수정' : ''));
      }
      (data.sections || []).forEach(function (sec) {
        var link = document.getElementById('toc-' + sec.id); if (!link) return;
        var missing = countMissing(sec.missing), state = sec.stale ? '재검토 필요' : missing ? '입력 ' + missing + '곳 필요' : sec.alerts ? '검토할 내용 있음' : sec.confirmed ? '확인 완료' : sec.edited ? '직접 수정 · 미확인' : '미확인';
        write(link.querySelector('.workspace-nav-state'), state);
        link.dataset.workspaceStatus = sec.stale || missing || sec.alerts ? 'attention' : sec.confirmed ? 'confirmed' : 'pending';
        link.setAttribute('aria-label', sec.label + ', ' + state);
        if (sec.id === data.current) link.setAttribute('aria-current', 'step'); else link.removeAttribute('aria-current');
      });
    }
    update(currentStatus, true);
    window.addEventListener('mse-workspace-change', function (event) { update(event.detail); });
    window.addEventListener('resize', function () { mountNavigation(); });
    api.setView({ focus: view.focus, preview: view.preview });
    // Reapply labels even if setView does not emit because the requested mode is already active.
    update(api.workspaceStatus());
    return { refresh: function () { update(api.workspaceStatus()); }, view: function () { return { focus: view.focus, preview: view.preview }; }, focusDetailOption: focusDetailOption };
  };
}());
