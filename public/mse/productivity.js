(function () {
  'use strict';
  var STORE = 'mse.productivity.v1', LIMIT = 100, MAX_FILE = 4194304, MAX_STORED = 6291456;
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function normalize(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function safeString(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
  function uniqueId() { return 'phrase-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  window.initMSEProductivity = function (api) {
    if (document.getElementById('mseProductivityToolbar')) return;
    var sections = api.sections(), validSections = new Set(sections.map(function (s) { return s.id; }));
    var state = { favorites: [], personal: [], center: [] }, catalog = [], tab = 'search', library = 'personal';
    var editing = null, editorBaseline = '', removed = null, origin = null, storageWarning = false;
    function phraseValid(p) {
      return p && typeof p === 'object' && safeString(p.label, 80) && safeString(p.text, 4000) &&
        typeof p.section === 'string' && validSections.has(p.section) && ['', 'self', 'observer', 'family'].indexOf(p.source) !== -1;
    }
    function cleanPhrase(p) { return { id: uniqueId(), label: p.label.trim(), text: p.text.trim(), section: p.section, source: p.source }; }
    try {
      var stored = localStorage.getItem(STORE) || 'null';
      if (stored.length > MAX_STORED) throw new Error('Stored settings are too large');
      var saved = JSON.parse(stored);
      if (saved && saved.version === 1) {
        if (Array.isArray(saved.favorites)) state.favorites = Array.from(new Set(saved.favorites.filter(function (x) { return safeString(x, 200); }))).slice(0, LIMIT);
        ['personal', 'center'].forEach(function (key) {
          if (Array.isArray(saved[key])) state[key] = saved[key].filter(phraseValid).slice(0, LIMIT).map(cleanPhrase);
        });
      }
    } catch (_) { storageWarning = true; }
    function announce(text) {
      if (storageWarning) text += ' PC 저장소를 사용할 수 없어 현재 실행에서만 반영됩니다. 문구는 내보내기로 보관하세요.';
      status.textContent = text; if (api.notify) api.notify(text);
    }
    function save() {
      try { localStorage.setItem(STORE, JSON.stringify({ version: 1, favorites: state.favorites, personal: state.personal, center: state.center })); storageWarning = false; }
      catch (_) { storageWarning = true; announce('이 PC에 설정을 저장하지 못했습니다.'); }
    }
    function button(text, action, cls) { var b = node('button', cls || 'tbtn', text); b.type = 'button'; b.addEventListener('click', action); return b; }
    var toolbar = node('div', 'mse-tools-bar'); toolbar.id = 'mseProductivityToolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '빠른 작업');
    toolbar.appendChild(button('선택지 찾기', function () { open('search'); }));
    toolbar.appendChild(button('즐겨찾기', function () { open('favorites'); }));
    toolbar.appendChild(button('재사용 문구', function () { open('phrases'); }));
    var keyHelp = button('단축키', function () { open('help'); }, 'tbtn mse-tools-help'); toolbar.appendChild(keyHelp);
    var top = document.querySelector('.top');
    if (top) top.insertAdjacentElement('afterend', toolbar); else document.body.insertBefore(toolbar, document.body.firstChild);
    var dialog = node('dialog', 'mse-tools-dialog'); dialog.id = 'mseProductivityDialog'; dialog.setAttribute('aria-labelledby', 'mseToolsTitle');
    var header = node('div', 'mse-tools-heading'), heading = node('h2', '', '빠른 작업'); heading.id = 'mseToolsTitle'; header.appendChild(heading);
    header.appendChild(button('닫기', close)); dialog.appendChild(header);
    var tabs = node('div', 'mse-tools-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '빠른 작업 종류');
    var panes = {}, tabButtons = {};
    [['search', '선택지 찾기'], ['favorites', '즐겨찾기'], ['phrases', '재사용 문구'], ['help', '단축키']].forEach(function (entry, index, all) {
      var id = entry[0], b = button(entry[1], function () { setTab(id); });
      b.id = 'mseToolsTab-' + id; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'mseToolsPane-' + id);
      b.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault(); var next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (index + (e.key === 'ArrowLeft' ? -1 : 1) + all.length) % all.length;
        setTab(all[next][0]); tabButtons[all[next][0]].focus();
      });
      tabButtons[id] = b; tabs.appendChild(b);
      var pane = node('div', 'mse-tools-pane'); pane.id = 'mseToolsPane-' + id; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', b.id); panes[id] = pane;
    });
    dialog.appendChild(tabs); Object.keys(panes).forEach(function (id) { dialog.appendChild(panes[id]); });
    var status = node('div', 'mse-tools-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); dialog.appendChild(status);
    document.body.appendChild(dialog);
    function refreshCatalog() {
      catalog = api.catalog().filter(function (item) { return item && safeString(item.id, 200) && typeof item.label === 'string'; });
    }
    function open(next) {
      if (!dialog.open) origin = document.activeElement;
      refreshCatalog(); setTab(next);
      if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
      status.textContent = storageWarning ? 'PC 저장소를 사용할 수 없습니다. 재사용 문구를 내보내 보관하세요.' : '';
      if (next === 'search') { query.focus(); query.select(); } else tabButtons[next].focus();
    }
    function close() {
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      if (origin && origin.isConnected && origin.focus) origin.focus();
    }
    dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    function setTab(next) {
      tab = next;
      Object.keys(panes).forEach(function (id) {
        panes[id].hidden = id !== next; tabButtons[id].setAttribute('aria-selected', String(id === next)); tabButtons[id].tabIndex = id === next ? 0 : -1;
      });
      if (next === 'search') renderSearch();
      if (next === 'favorites') renderFavorites();
      if (next === 'phrases') renderPhrases();
    }
    function jump(item) { close(); api.jump(item.id); }
    function resultRow(item) {
      var row = node('div', 'mse-tools-result'), go = button('', function () { jump(item); }, 'mse-tools-go');
      go.appendChild(node('span', 'mse-tools-path', item.section || ''));
      go.appendChild(node('strong', '', item.label));
      if (item.detail) go.appendChild(node('span', 'mse-tools-detail', item.detail));
      var pinned = state.favorites.indexOf(item.id) !== -1;
      var pin = button(pinned ? '★' : '☆', function () {
        var previousPins = Array.from(panes[tab].querySelectorAll('[data-pin-id]'));
        var previousIndex = previousPins.indexOf(pin);
        var at = state.favorites.indexOf(item.id);
        if (at !== -1) state.favorites.splice(at, 1);
        else if (state.favorites.length < LIMIT) state.favorites.push(item.id);
        else { announce('즐겨찾기는 최대 ' + LIMIT + '개까지 등록할 수 있습니다.'); return; }
        save(); renderSearch(); renderFavorites();
        var currentPins = Array.from(panes[tab].querySelectorAll('[data-pin-id]'));
        var updated = currentPins.find(function (n) { return n.dataset.pinId === item.id; }) || currentPins[Math.min(previousIndex, currentPins.length - 1)] || tabButtons[tab];
        updated.focus();
      }, 'mse-tools-pin');
      pin.dataset.pinId = item.id; pin.setAttribute('aria-label', item.label + (pinned ? ' 즐겨찾기 해제' : ' 즐겨찾기 추가')); pin.setAttribute('aria-pressed', String(pinned));
      row.appendChild(go); row.appendChild(pin); return row;
    }
    var searchLabel = node('label', 'mse-tools-field-label', '선택지 이름·설명 검색'); searchLabel.htmlFor = 'mseToolsQuery'; panes.search.appendChild(searchLabel);
    var query = node('input', 'mse-tools-query'); query.type = 'search'; query.id = 'mseToolsQuery'; query.placeholder = '예: 시선, 위생, 불안, speech'; query.autocomplete = 'off'; query.maxLength = 100;
    panes.search.appendChild(query); panes.search.appendChild(node('p', 'mse-tools-hint', '결과를 누르면 해당 항목으로 이동합니다. 선택 상태는 바뀌지 않습니다.'));
    var count = node('p', 'mse-tools-count'); count.setAttribute('aria-live', 'polite'); panes.search.appendChild(count);
    var results = node('div', 'mse-tools-results'); panes.search.appendChild(results);
    query.addEventListener('input', renderSearch);
    query.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown') { var first = results.querySelector('button'); if (first) { e.preventDefault(); first.focus(); } } });
    function renderSearch() {
      var terms = normalize(query.value).split(' ').filter(Boolean);
      var found = terms.length ? catalog.filter(function (item) { var hay = normalize([item.section, item.label, item.detail].join(' ')); return terms.every(function (term) { return hay.indexOf(term) !== -1; }); }) : [];
      results.textContent = '';
      count.textContent = !terms.length ? '찾을 단어를 입력하세요.' : found.length ? found.length + '개 결과' + (found.length > 60 ? ' · 처음 60개 표시. 단어를 추가하면 더 좁힐 수 있습니다.' : '') : '일치하는 항목이 없습니다. 다른 단어로 찾아보세요.';
      found.slice(0, 60).forEach(function (item) { results.appendChild(resultRow(item)); });
    }
    panes.favorites.appendChild(node('p', 'mse-tools-hint', '자주 확인하는 선택지를 검색 결과의 ☆로 등록하세요. 즐겨찾기는 항목으로 이동하는 기능입니다.'));
    var favoriteList = node('div', 'mse-tools-results'); panes.favorites.appendChild(favoriteList);
    function renderFavorites() {
      favoriteList.textContent = ''; var byId = new Map(catalog.map(function (item) { return [item.id, item]; }));
      var rows = state.favorites.map(function (id) { return byId.get(id); }).filter(Boolean);
      if (!rows.length) favoriteList.appendChild(node('p', 'mse-tools-empty', '등록한 즐겨찾기가 없습니다.'));
      rows.forEach(function (item) { favoriteList.appendChild(resultRow(item)); });
    }
    var libraries = node('div', 'mse-tools-library-bar'), librarySelect = node('select'); librarySelect.setAttribute('aria-label', '문구 보관함');
    [['personal', '내 문구'], ['center', '센터 공통 문구']].forEach(function (entry) { var o = node('option', '', entry[1]); o.value = entry[0]; librarySelect.appendChild(o); });
    libraries.appendChild(librarySelect);
    var addPhraseButton = button('문구 추가', function () { editPhrase(null); }); libraries.appendChild(addPhraseButton);
    libraries.appendChild(button('가져오기', function () { importFile.value = ''; importFile.click(); }));
    libraries.appendChild(button('내보내기', exportLibrary)); panes.phrases.appendChild(libraries);
    panes.phrases.appendChild(node('p', 'mse-tools-hint', '반복해서 쓸 일반 문구만 저장하세요. 이름·연락처·개별 사례는 저장하지 마세요. 센터 공통 문구도 이 PC에 보관되며, 파일로 주고받을 수 있습니다.'));
    librarySelect.addEventListener('change', function () { if (!allowEditorChange()) { librarySelect.value = library; return; } library = librarySelect.value; editing = null; editor.hidden = true; removed = null; renderPhrases(); });
    var importFile = node('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true; panes.phrases.appendChild(importFile);
    importFile.addEventListener('change', async function () {
      var file = importFile.files && importFile.files[0]; if (!file) return;
      var destination = library;
      if (file.size > MAX_FILE) { announce('문구 파일은 4MB 이하만 가져올 수 있습니다.'); return; }
      try {
        var text = typeof file.text === 'function' ? await file.text() : await new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = reject; reader.readAsText(file); });
        importLibrary(text, destination);
      } catch (_) { announce('문구 파일을 읽지 못했습니다. 이 도구에서 내보낸 JSON 파일인지 확인하세요.'); }
    });
    function signature(p) { return JSON.stringify([p.label.trim(), p.text.trim(), p.section, p.source]); }
    function importLibrary(text, destination) {
      if (typeof text !== 'string' || text.length > MAX_FILE) throw new Error('file too large');
      var parsed = JSON.parse(text);
      if (!parsed || parsed.kind !== 'mse-reusable-phrases' || parsed.version !== 1 || !Array.isArray(parsed.phrases) || parsed.phrases.length > LIMIT || !parsed.phrases.every(phraseValid)) throw new Error('invalid phrase file');
      var known = new Set(state[destination].map(signature)), incoming = [];
      parsed.phrases.forEach(function (phrase) { var key = signature(phrase); if (!known.has(key)) { known.add(key); incoming.push(cleanPhrase(phrase)); } });
      if (state[destination].length + incoming.length > LIMIT) { announce('보관함은 최대 ' + LIMIT + '개입니다. 일부 문구를 정리한 뒤 다시 가져오세요.'); return; }
      state[destination] = state[destination].concat(incoming); save(); renderPhrases(); announce(incoming.length + '개 문구를 ' + (destination === 'personal' ? '내 문구' : '센터 공통 문구') + '에 추가했습니다. 중복 문구는 건너뜁니다.');
    }
    function exportLibrary() {
      if (!state[library].length) { announce('내보낼 문구가 없습니다.'); return; }
      try {
        var data = { kind: 'mse-reusable-phrases', version: 1, library: library, phrases: state[library].map(function (p) { return { label: p.label, text: p.text, section: p.section, source: p.source }; }) };
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = 'MSE-' + (library === 'personal' ? '내문구' : '센터공통문구') + '.json'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000); announce('문구 파일 다운로드를 요청했습니다. 저장된 파일을 확인하세요.');
      } catch (_) { announce('내보내기를 시작하지 못했습니다. 잠시 후 다시 시도하세요.'); }
    }
    var editor = node('form', 'mse-tools-editor'); editor.hidden = true; panes.phrases.appendChild(editor);
    var editorTitle = node('h3', '', '문구 추가'); editor.appendChild(editorTitle);
    function field(label, input) { var wrapper = node('label', 'mse-tools-field', label); wrapper.appendChild(input); editor.appendChild(wrapper); return input; }
    var phraseLabel = node('input'); phraseLabel.type = 'text'; phraseLabel.maxLength = 80; phraseLabel.required = true; field('문구 이름', phraseLabel);
    var phraseSection = node('select'); sections.forEach(function (s) { var o = node('option', '', s.label); o.value = s.id; phraseSection.appendChild(o); }); field('추가할 MSE 영역', phraseSection);
    var phraseSource = node('select'); [['', '출처 문구 없음'], ['self', '대상자 진술'], ['observer', '면담자 관찰'], ['family', '가족·보호자 진술']].forEach(function (entry) { var o = node('option', '', entry[1]); o.value = entry[0]; phraseSource.appendChild(o); }); field('정보 출처', phraseSource);
    var phraseText = node('textarea'); phraseText.rows = 4; phraseText.maxLength = 4000; phraseText.required = true; field('재사용할 일반 문구', phraseText);
    var editorButtons = node('div', 'mse-tools-actions'), submit = node('button', 'tbtn primary', '문구 저장'); submit.type = 'submit'; editorButtons.appendChild(submit);
    editorButtons.appendChild(button('취소', function () { var previous = editing; editor.hidden = true; editing = null; focusPhrase(previous, 'edit'); })); editor.appendChild(editorButtons);
    function editorValue() { return JSON.stringify([phraseLabel.value, phraseSection.value, phraseSource.value, phraseText.value]); }
    function allowEditorChange() {
      if (editor.hidden || editorValue() === editorBaseline) return true;
      announce('작성 중인 문구를 먼저 저장하거나 취소하세요. 입력한 내용은 그대로 유지됩니다.'); phraseLabel.focus(); return false;
    }
    function editPhrase(p) {
      if (!allowEditorChange()) return;
      if (!p && state[library].length >= LIMIT) { announce('보관함은 최대 ' + LIMIT + '개까지 등록할 수 있습니다.'); return; }
      editing = p ? p.id : null; editorTitle.textContent = p ? '문구 수정' : '문구 추가'; phraseLabel.value = p ? p.label : ''; phraseSection.value = p ? p.section : sections[0].id;
      phraseSource.value = p ? p.source : ''; phraseText.value = p ? p.text : ''; editorBaseline = editorValue(); editor.hidden = false; phraseLabel.focus();
    }
    editor.addEventListener('submit', function (e) {
      e.preventDefault(); var p = { id: editing || uniqueId(), label: phraseLabel.value.trim(), text: phraseText.value.trim(), section: phraseSection.value, source: phraseSource.value };
      if (!phraseValid(p)) { announce('문구 이름·내용과 MSE 영역을 확인하세요.'); return; }
      var index = state[library].findIndex(function (x) { return x.id === editing; });
      if (index >= 0) state[library][index] = p; else if (state[library].length < LIMIT) state[library].push(p); else { announce('보관함은 최대 ' + LIMIT + '개입니다.'); return; }
      var wasEditing = editing !== null;
      save(); editing = null; editor.hidden = true; renderPhrases(); focusPhrase(p.id, wasEditing ? 'edit' : 'insert'); announce('재사용 문구를 저장했습니다.');
    });
    var phraseList = node('div', 'mse-tools-phrases'); panes.phrases.appendChild(phraseList);
    function focusPhrase(id, action) {
      var card = Array.from(phraseList.querySelectorAll('[data-phrase-id]')).find(function (n) { return n.dataset.phraseId === id; });
      var target = card && card.querySelector('[data-phrase-action="' + action + '"]:not(:disabled)');
      (target || card || addPhraseButton).focus();
    }
    function phraseAction(text, action, callback, cls) { var b = button(text, callback, cls); b.dataset.phraseAction = action; return b; }
    function renderPhrases() {
      phraseList.textContent = '';
      if (removed && removed.library === library) {
        var restore = button('방금 삭제한 문구 복원', function () { if (state[library].length >= LIMIT) { announce('문구가 100개입니다. 한 개를 정리한 뒤 복원하세요.'); return; } var restoredId = removed.phrase.id; state[library].splice(Math.min(removed.index, state[library].length), 0, removed.phrase); removed = null; save(); renderPhrases(); focusPhrase(restoredId, 'edit'); announce('삭제한 문구를 복원했습니다.'); });
        restore.classList.add('mse-tools-restore'); phraseList.appendChild(restore);
      }
      if (!state[library].length) phraseList.appendChild(node('p', 'mse-tools-empty', '등록된 문구가 없습니다. 자주 사용하는 일반 문구를 추가해 보세요.'));
      state[library].forEach(function (p, index) {
        var card = node('article', 'mse-tools-phrase'), labels = sections.find(function (s) { return s.id === p.section; });
        card.dataset.phraseId = p.id; card.tabIndex = -1; card.setAttribute('aria-label', p.label);
        var sourceLabel = { self: '대상자 진술', observer: '면담자 관찰', family: '가족·보호자 진술' }[p.source];
        card.appendChild(node('h3', '', p.label)); card.appendChild(node('p', 'mse-tools-path', (labels ? labels.label : p.section) + (sourceLabel ? ' · ' + sourceLabel : ''))); card.appendChild(node('p', 'mse-tools-phrase-text', p.text));
        var actions = node('div', 'mse-tools-actions');
        actions.appendChild(phraseAction('작성 결과에 추가', 'insert', function () { close(); api.insertPhrase(p.section, p.text, p.source); }, 'tbtn primary'));
        actions.appendChild(phraseAction('수정', 'edit', function () { editPhrase(p); }));
        var up = phraseAction('위로', 'up', function () { movePhrase(index, -1); }); up.disabled = index === 0; up.setAttribute('aria-label', p.label + ' 위로 이동'); actions.appendChild(up);
        var down = phraseAction('아래로', 'down', function () { movePhrase(index, 1); }); down.disabled = index === state[library].length - 1; down.setAttribute('aria-label', p.label + ' 아래로 이동'); actions.appendChild(down);
        actions.appendChild(phraseAction('삭제', 'delete', function () { removed = { library: library, index: index, phrase: p }; state[library].splice(index, 1); if (editing === p.id) { editing = null; editor.hidden = true; } save(); renderPhrases(); phraseList.querySelector('.mse-tools-restore').focus(); announce('문구를 삭제했습니다. 방금 삭제한 문구는 복원할 수 있습니다.'); }));
        card.appendChild(actions); phraseList.appendChild(card);
      });
    }
    function movePhrase(index, delta) {
      var target = index + delta; if (target < 0 || target >= state[library].length) return;
      var p = state[library].splice(index, 1)[0]; state[library].splice(target, 0, p); save(); renderPhrases();
      focusPhrase(p.id, delta < 0 ? 'up' : 'down');
    }
    var helpRows = [ ['F1', '사용안내 열기'], ['Ctrl + K', '선택지 검색 열기'], ['F6 / Shift + F6', '목차 · 면담 입력 · 작성 결과 사이로 초점 이동'], ['Alt + ← / →', '이전 / 다음 MSE 영역으로 이동'], ['Ctrl + Shift + R', '누락·검토 항목 확인'], ['Ctrl + Z', '마지막 입력·선택 변경 실행 취소'], ['Ctrl + Shift + Z / Ctrl + Y', '다시 실행'], ['Esc', '빠른 작업 닫기'] ];
    var helpList = node('dl', 'mse-tools-key-list'); helpRows.forEach(function (row) { helpList.appendChild(node('dt', '', row[0])); helpList.appendChild(node('dd', '', row[1])); }); panes.help.appendChild(helpList);
    panes.help.appendChild(node('p', 'mse-tools-hint', '글을 입력 중일 때 Ctrl + Z / Y는 해당 입력칸의 편집 기능으로 동작합니다. 전체 변경을 되돌리려면 화면 하단의 실행 취소 버튼을 사용하세요. F1과 F6은 열린 대화상자를 닫은 뒤 사용할 수 있습니다.'));
    function editable(target) { return target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[contenteditable="true"]')); }
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.isComposing) return;
      var key = e.key.toLowerCase(), command = e.ctrlKey || e.metaKey;
      var otherDialog = document.querySelector('dialog[open]:not(#mseProductivityDialog)');
      if (otherDialog) return;
      if (command && !e.altKey && !e.shiftKey && key === 'k') { e.preventDefault(); open('search'); return; }
      if (dialog.open) return;
      if (command && e.shiftKey && !e.altKey && key === 'r') { e.preventDefault(); api.openReview(); return; }
      if (editable(e.target)) return;
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); api.moveSection(e.key === 'ArrowLeft' ? -1 : 1); return; }
      if (command && !e.altKey && (key === 'z' || key === 'y')) { e.preventDefault(); if (key === 'y' || e.shiftKey) api.redo(); else api.undo(); }
    });
    // This API exposes only UI operations; patient notes never enter this store.
    return { open: open, close: close, refresh: refreshCatalog };
  };
}());
