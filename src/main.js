(() => {
  'use strict';

  const STORAGE = { cases: 'gir_cases_v3' };
  const VIEWS = ['submit', 'tracker', 'directory'];
  const DEFAULT_LOGO = 'assets/favicon.svg';
  let companies = [...GLOBAL_COMPANIES];
  let cases = [];
  let selectedCompany = null;
  let latestCase = null;
  let activeModal = null;
  let lastFocusedElement = null;

  const $ = id => document.getElementById(id);
  const escapeStr = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
  const cleanText = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 5000) : fallback;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function readStorage(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      notifyToast('Browser storage is unavailable. Copy your reference and case details now.');
      return false;
    }
  }

  function normalizeCase(item) {
    if (!item || typeof item !== 'object' || !item.ref || !item.companyName) return null;
    return {
      ref: cleanText(item.ref), companyName: cleanText(item.companyName),
      companyRegion: cleanText(item.companyRegion, 'Global'), companySector: cleanText(item.companySector, 'Customer Service & Support'),
      customerName: cleanText(item.customerName), customerEmail: cleanText(item.customerEmail),
      customerPhone: cleanText(item.customerPhone), accountRef: cleanText(item.accountRef, 'N/A'),
      issueCategory: cleanText(item.issueCategory), priority: cleanText(item.priority, 'Standard'),
      resolution: cleanText(item.resolution), description: cleanText(item.description),
      status: cleanText(item.status, 'Submitted'), createdAt: cleanText(item.createdAt)
    };
  }

  const remoteCompanyCache = new Map();
  const remoteCompanyRequests = new Map();
  let companyLookupTimer = null;
  let companyLookupRequest = 0;
  let directoryLookupTimer = null;
  let directoryLookupRequest = 0;

  function normalizeCompanyQuery(value) {
    return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }

  function normalizeRemoteCompany(item) {
    if (!item || typeof item !== 'object' || !item.id || !item.name) return null;
    return {
      id: cleanText(item.id).slice(0, 80),
      name: cleanText(item.name).slice(0, 120),
      domain: cleanText(item.domain).slice(0, 255),
      sector: 'Customer Service & Support',
      region: 'Global',
      logo: cleanText(item.logoUrl, DEFAULT_LOGO),
      hasCachedLogo: Boolean(item.logoUrl),
      cacheId: cleanText(item.logoCacheId || item.id),
      custom: true
    };
  }

  function searchRemoteCompanies(rawQuery) {
    const key = normalizeCompanyQuery(rawQuery);
    if (key.length < 2) return Promise.resolve([]);
    if (remoteCompanyCache.has(key)) return Promise.resolve(remoteCompanyCache.get(key));
    if (remoteCompanyRequests.has(key)) return remoteCompanyRequests.get(key);
    const request = fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'search', query: rawQuery.trim().slice(0, 120) })
    }).then(async response => {
      if (!response.ok) throw new Error('Company search unavailable');
      const payload = await response.json();
      const results = (Array.isArray(payload.companies) ? payload.companies : [])
        .map(normalizeRemoteCompany).filter(Boolean);
      remoteCompanyCache.set(key, results);
      return results;
    }).finally(() => remoteCompanyRequests.delete(key));
    remoteCompanyRequests.set(key, request);
    return request;
  }

  function mergeRemoteCompanies(remoteCompanies) {
    const results = [];
    remoteCompanies.forEach(remoteCompany => {
      const existing = companies.find(company => company.id === remoteCompany.id ||
        (remoteCompany.domain && company.domain === remoteCompany.domain));
      if (existing) results.push(existing);
      else {
        companies.unshift(remoteCompany);
        results.push(remoteCompany);
      }
    });
    return results;
  }

  function initApp() {
    cases = readStorage(STORAGE.cases).map(normalizeCase).filter(Boolean);
    companies = [...GLOBAL_COMPANIES];

    bindEvents();
    renderAll();
    $('currentYear').textContent = new Date().getFullYear();
    $('referencePreview').textContent = `Reference: GIR-${new Date().getFullYear()}-XXXXX`;
    $('heroCompanyTotal').textContent = `${GLOBAL_COMPANIES.length.toLocaleString('en-GB')} companies indexed`;
    document.querySelectorAll('[data-view="directory"]').forEach(btn => {
      if (/View all/.test(btn.textContent)) btn.textContent = `View all ${GLOBAL_COMPANIES.length.toLocaleString('en-GB')}`;
    });

    const params = new URLSearchParams(window.location.search);
    const deepCompany = (params.get('company') || '').trim();
    if (deepCompany) {
      const match = companies.find(company => company.name.toLowerCase() === deepCompany.toLowerCase() || (company.domain || '').toLowerCase() === deepCompany.toLowerCase());
      if (match) selectCompany(match.id);
      else $('companySearchInput').value = deepCompany;
    }

    const initialHash = window.location.hash.slice(1);
    if (initialHash === 'faq') switchView('submit', { updateHash: false, scroll: false });
    else switchView(VIEWS.includes(initialHash) ? initialHash : 'submit', { updateHash: false, scroll: false });
    if (deepCompany && !selectedCompany) {
      switchView('submit', { updateHash: false, scroll: false });
      filterCompanyDropdown(true);
    }
    if (initialHash === 'faq') setTimeout(() => $('faq').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' }), 0);
  }

  function bindEvents() {
    document.addEventListener('click', event => {
      const viewTrigger = event.target.closest('[data-view]');
      if (viewTrigger) {
        event.preventDefault();
        switchView(viewTrigger.dataset.view);
        return;
      }
      const faqTrigger = event.target.closest('a[href="#faq"]');
      if (faqTrigger) {
        event.preventDefault();
        switchView('submit', { updateHash: false });
        history.pushState(null, '', '#faq');
        $('faq').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    });

    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.slice(1);
      if (hash === 'faq') {
        switchView('submit', { updateHash: false });
        $('faq').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
      } else if (VIEWS.includes(hash)) switchView(hash, { updateHash: false });
    });

    $('companySearchInput').addEventListener('focus', openCompanyDropdown);
    $('companySearchInput').addEventListener('input', event => {
      if (selectedCompany && event.target.value !== selectedCompany.name) clearSelectedCompany(false, false);
      filterCompanyDropdown();
    });
    $('companySearchInput').addEventListener('keydown', event => {
      if (event.key === 'Escape') closeCompanyDropdown();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openCompanyDropdown();
        $('companyDropdownList').querySelector('button')?.focus();
      }
      if (event.key === 'Enter') {
        if (event.isComposing || event.keyCode === 229) return;
        const typed = event.target.value.trim();
        if (!typed || $('companyDropdownList').hidden) return;
        event.preventDefault();
        const exact = companies.find(company => normalizeCompanyQuery(company.name) === normalizeCompanyQuery(typed));
        if (exact) selectCompany(exact.id);
        else void resolveTypedCompany(typed);
      }
    });
    $('browseCompanies').addEventListener('click', () => {
      if ($('companyDropdownList').hidden) {
        renderCompanyDropdown(companies, $('companySearchInput').value.trim());
        openCompanyDropdown();
      } else closeCompanyDropdown();
    });
    $('companyDropdownList').addEventListener('click', event => {
      const companyButton = event.target.closest('[data-company-id]');
      const quickButton = event.target.closest('[data-quick-name]');
      if (companyButton) selectCompany(companyButton.dataset.companyId);
      if (quickButton) quickAddCompany(quickButton.dataset.quickName);
    });
    $('companyDropdownList').addEventListener('keydown', event => {
      const buttons = [...event.currentTarget.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); buttons[Math.min(index + 1, buttons.length - 1)]?.focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); index <= 0 ? $('companySearchInput').focus() : buttons[index - 1]?.focus(); }
      if (event.key === 'Escape') { closeCompanyDropdown(); $('companySearchInput').focus(); }
    });
    document.addEventListener('click', event => {
      if (!$('companySearchBox').contains(event.target)) closeCompanyDropdown();
    });
    $('clearCompany').addEventListener('click', () => clearSelectedCompany(true));
    $('trendingCompaniesSidebar').addEventListener('click', event => {
      const button = event.target.closest('[data-select-company]');
      if (button) {
        switchView('submit');
        selectCompany(button.dataset.selectCompany);
        $('companySearchInput').focus();
      }
    });
    $('directoryCardsGrid').addEventListener('click', event => {
      const button = event.target.closest('[data-start-case]');
      if (button) startCaseFromDirectory(button.dataset.startCase);
    });
    ['dirSearch', 'dirRegion', 'dirSector'].forEach(id => $(id).addEventListener(id === 'dirSearch' ? 'input' : 'change', renderDirectoryGrid));
    ['trackerSearchInput', 'trackerStatusFilter'].forEach(id => $(id).addEventListener(id === 'trackerSearchInput' ? 'input' : 'change', renderTrackerList));
    $('trackerResultsList').addEventListener('click', event => {
      const button = event.target.closest('[data-copy-ref]');
      if (button) copyText(button.dataset.copyRef, 'Case reference copied.');
    });

    $('caseForm').addEventListener('submit', submitCustomerCase);
    ['openCustomCompany', 'openCustomCompanyDirectory'].forEach(id => $(id).addEventListener('click', () => openCustomCompanyModal(id === 'openCustomCompany' ? $('companySearchInput').value.trim() : '')));
    $('customCompanyForm').addEventListener('submit', saveCustomCompany);
    ['closeCustomCompany', 'closeCustomCompanyX'].forEach(id => $(id).addEventListener('click', () => closeModal($('customCompanyModal'))));
    ['closeConfirmation'].forEach(id => $(id).addEventListener('click', () => closeModal($('confirmationModal'))));
    $('copyReference').addEventListener('click', () => latestCase && copyText(latestCase.ref, 'Case reference copied.'));
    $('trackSubmittedCase').addEventListener('click', () => { closeModal($('confirmationModal')); switchView('tracker'); });
    $('printCase').addEventListener('click', () => window.print());

    document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('mousedown', event => {
      if (event.target === modal) closeModal(modal);
    }));
    document.addEventListener('keydown', handleModalKeyboard);
    document.addEventListener('error', event => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.hasAttribute('data-company-logo')) return;
      const cacheId = image.dataset.companyCacheId;
      if (cacheId && !image.dataset.logoRepairTried) {
        image.dataset.logoRepairTried = 'true';
        void fetch('/api/companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'repair', id: cacheId })
        }).then(response => response.ok ? response.json() : null).then(payload => {
          const repaired = normalizeRemoteCompany(payload?.company);
          if (repaired?.hasCachedLogo) {
            const cached = companies.find(company => company.cacheId === cacheId || company.id === cacheId);
            if (cached) cached.logo = repaired.logo;
            if (selectedCompany?.cacheId === cacheId) selectedCompany.logo = repaired.logo;
            image.src = repaired.logo;
            return;
          }
          showLogoFallback(image);
        }).catch(() => showLogoFallback(image));
        return;
      }
      showLogoFallback(image);
    }, true);
  }

  function renderAll() {
    renderTrendingSidebar();
    renderDirectoryGrid();
    renderTrackerList();
    renderRecentCases();
    updateHeaderCounts();
  }

  function switchView(viewName, options = {}) {
    if (!VIEWS.includes(viewName)) viewName = 'submit';
    const { updateHash = true, scroll = true } = options;
    VIEWS.forEach(view => {
      $(`view-${view}`).hidden = view !== viewName;
      const nav = $(`nav-${view}`);
      if (view === viewName) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    });
    closeCompanyDropdown();
    if (updateHash && window.location.hash !== `#${viewName}`) history.pushState(null, '', `#${viewName}`);
    const pageMetadata = {
      submit: {
        title: 'GetItResolved | Customer Complaint Case Portal',
        shareTitle: 'GetItResolved — Make your complaint easier to track',
        description: 'Submit a customer service complaint, receive a unique GetItResolved case reference, and keep your details organised for follow-up.'
      },
      tracker: {
        title: 'Track a Saved Case | GetItResolved',
        shareTitle: 'Track a Saved Case | GetItResolved',
        description: 'Review, copy, or print GetItResolved case references saved in this browser to keep complaint details ready for follow-up.'
      },
      directory: {
        title: 'Global Company Directory | GetItResolved',
        shareTitle: 'Global Company Directory | GetItResolved',
        description: `Search ${GLOBAL_COMPANIES.length.toLocaleString('en-GB')} companies across the UK, US, Europe, and global markets before preparing a customer service case.`
      }
    };
    const metadata = pageMetadata[viewName];
    document.title = metadata.title;
    document.querySelector('meta[name="description"]').content = metadata.description;
    document.querySelector('meta[property="og:title"]').content = metadata.shareTitle;
    document.querySelector('meta[property="og:description"]').content = metadata.description;
    document.querySelector('meta[name="twitter:title"]').content = metadata.shareTitle;
    document.querySelector('meta[name="twitter:description"]').content = metadata.description;
    if (scroll) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function showLogoFallback(image) {
    if (image.id === 'selCompLogoImg') {
      if (!image.src.endsWith('/assets/favicon.svg')) image.src = DEFAULT_LOGO;
      return;
    }
    const frame = image.closest('.logo-frame');
    if (frame) frame.innerHTML = '<span class="logo-unavailable" aria-hidden="true">Logo unavailable</span>';
  }

  function logoMarkup(company, eager = false) {
    const cacheId = company.cacheId && company.hasCachedLogo ? company.cacheId : '';
    return `<span class="logo-frame"><img src="${escapeStr(company.logo || DEFAULT_LOGO)}" alt="" width="40" height="40" ${eager ? '' : 'loading="lazy"'} decoding="async" data-company-logo ${cacheId ? `data-company-cache-id="${escapeStr(cacheId)}"` : ''}></span>`;
  }

  function openCompanyDropdown() {
    filterCompanyDropdown(false);
    $('companyDropdownList').hidden = false;
    $('companySearchInput').setAttribute('aria-expanded', 'true');
  }

  function closeCompanyDropdown() {
    $('companyDropdownList').hidden = true;
    $('companySearchInput').setAttribute('aria-expanded', 'false');
  }

  function filterCompanyDropdown(open = true) {
    const rawQuery = $('companySearchInput').value.trim();
    const normalized = normalizeCompanyQuery(rawQuery);
    const filtered = companies.filter(company => [company.name, company.domain].some(value => normalizeCompanyQuery(value).includes(normalized)));
    window.clearTimeout(companyLookupTimer);
    const requestId = ++companyLookupRequest;
    const needsRemoteSearch = normalized.length >= 2 && filtered.length === 0;
    renderCompanyDropdown(filtered, rawQuery, { loading: needsRemoteSearch });
    if (needsRemoteSearch && !remoteCompanyCache.has(normalized)) {
      companyLookupTimer = window.setTimeout(async () => {
        try {
          const matches = mergeRemoteCompanies(await searchRemoteCompanies(rawQuery));
          if (requestId !== companyLookupRequest || normalizeCompanyQuery($('companySearchInput').value) !== normalized) return;
          const currentMatches = matches.filter(company => normalizeCompanyQuery(company.name).includes(normalized) || normalizeCompanyQuery(company.domain).includes(normalized));
          renderCompanyDropdown(currentMatches, rawQuery);
        } catch {
          if (requestId === companyLookupRequest) renderCompanyDropdown([], rawQuery, { error: true });
        }
      }, 280);
    } else if (needsRemoteSearch && remoteCompanyCache.has(normalized)) {
      const matches = mergeRemoteCompanies(remoteCompanyCache.get(normalized));
      renderCompanyDropdown(matches, rawQuery);
    }
    if (open) {
      $('companyDropdownList').hidden = false;
      $('companySearchInput').setAttribute('aria-expanded', 'true');
    }
  }

  function renderCompanyDropdown(list, rawQuery = '', state = {}) {
    const menu = $('companyDropdownList');
    const safeQuery = rawQuery.trim();
    const status = state.loading
      ? '<div class="empty-dropdown" role="status">Searching verified company sources…</div>'
      : state.error
        ? '<div class="empty-dropdown" role="status">Company search is temporarily unavailable.</div>'
        : '';
    const custom = !list.length && !state.loading && safeQuery.length > 1
      ? `<div class="dropdown-custom"><p>${state.error ? 'You can retry by editing the search, or continue with the name only.' : `No verified company match for “${escapeStr(safeQuery)}”. You can still submit using the name only.`}</p><button type="button" class="button button-primary" data-quick-name="${escapeStr(safeQuery)}">Use name only</button></div>`
      : '';
    const options = list.slice(0, 80).map(company => `<button type="button" class="company-option" role="option" data-company-id="${escapeStr(company.id)}"><span class="company-option-main">${logoMarkup(company)}<span class="company-option-copy"><span class="company-option-name">${escapeStr(company.name)}</span></span></span><span class="option-action">Select <span aria-hidden="true">→</span></span></button>`).join('');
    menu.innerHTML = status + custom + options || '<div class="empty-dropdown">Type a company name to search.</div>';
  }

  async function resolveTypedCompany(rawQuery) {
    const query = rawQuery.trim();
    const normalized = normalizeCompanyQuery(query);
    const menu = $('companyDropdownList');
    renderCompanyDropdown([], query, { loading: true });
    try {
      const matches = mergeRemoteCompanies(await searchRemoteCompanies(query));
      const exact = matches.filter(company => normalizeCompanyQuery(company.name) === normalized);
      if (exact.length === 1) {
        selectCompany(exact[0].id);
        return;
      }
      renderCompanyDropdown(matches, query);
    } catch {
      renderCompanyDropdown([], query, { error: true });
    }
    menu.hidden = false;
    $('companySearchInput').setAttribute('aria-expanded', 'true');
  }

  function selectCompany(companyId) {
    const company = typeof companyId === 'object' ? companyId : companies.find(item => item.id === companyId);
    if (!company) return;
    selectedCompany = company;
    $('companySearchInput').value = company.name;
    closeCompanyDropdown();
    hideFormError();
    $('selectedCompanyBanner').hidden = false;
    const image = $('selCompLogoImg');
    image.src = company.logo || DEFAULT_LOGO;
    image.alt = '';
    image.dataset.companyLogo = '';
    if (company.cacheId && company.hasCachedLogo) image.dataset.companyCacheId = company.cacheId;
    else delete image.dataset.companyCacheId;
    delete image.dataset.logoRepairTried;
    $('selCompName').textContent = company.name;
    const dial = $('custDialCode');
    if (['United States', 'Canada'].includes(company.region)) dial.value = '+1';
    else if (company.region === 'United Kingdom') dial.value = '+44';
    else if (company.region === 'Australia') dial.value = '+61';
  }

  function clearSelectedCompany(focus = true, clearInput = true) {
    selectedCompany = null;
    $('selectedCompanyBanner').hidden = true;
    if (clearInput) $('companySearchInput').value = '';
    if (focus) $('companySearchInput').focus();
  }

  function startCaseFromDirectory(companyId) {
    switchView('submit');
    selectCompany(companyId);
    setTimeout(() => $('custName').focus(), reducedMotion() ? 0 : 180);
  }

  function renderTrendingSidebar() {
    const trending = companies.filter(company => company.trending).slice(0, 7);
    $('trendingCompaniesSidebar').innerHTML = trending.map(company => `<button type="button" class="company-list-item" data-select-company="${escapeStr(company.id)}"><span class="company-line">${logoMarkup(company, true)}<span class="company-copy"><span class="company-name">${escapeStr(company.name)}</span></span></span><span class="list-select">Select</span></button>`).join('');
  }

  function renderDirectoryGrid() {
    const rawQuery = $('dirSearch').value.trim();
    const normalized = normalizeCompanyQuery(rawQuery);
    const region = $('dirRegion').value;
    const sector = $('dirSector').value;
    const nameMatches = companies.filter(company => [company.name, company.domain].some(value => normalizeCompanyQuery(value).includes(normalized)));
    const filtered = nameMatches.filter(company => (region === 'ALL' || company.region === region) && (sector === 'ALL' || company.sector === sector));
    $('directoryResultCount').textContent = `${filtered.length.toLocaleString('en-GB')} ${filtered.length === 1 ? 'company' : 'companies'} found`;
    if (!filtered.length && normalized.length >= 2 && !nameMatches.length && !remoteCompanyCache.has(normalized)) {
      window.clearTimeout(directoryLookupTimer);
      const requestId = ++directoryLookupRequest;
      $('directoryResultCount').textContent = 'Searching verified company sources…';
      $('directoryCardsGrid').innerHTML = '<div class="empty-state" role="status"><h3>Searching company names</h3><p>Checking the shared company directory and verified public sources.</p></div>';
      directoryLookupTimer = window.setTimeout(async () => {
        try {
          mergeRemoteCompanies(await searchRemoteCompanies(rawQuery));
          if (requestId === directoryLookupRequest && normalizeCompanyQuery($('dirSearch').value) === normalized) renderDirectoryGrid();
        } catch {
          if (requestId === directoryLookupRequest) {
            $('directoryResultCount').textContent = 'Search unavailable';
            $('directoryCardsGrid').innerHTML = '<div class="empty-state"><h3>Company search is temporarily unavailable</h3><p>Try again by editing the company name.</p></div>';
          }
        }
      }, 280);
      return;
    }
    window.clearTimeout(directoryLookupTimer);
    if (!filtered.length) {
      $('directoryCardsGrid').innerHTML = '<div class="empty-state"><h3>No companies match these filters</h3><p>Clear a filter or search for a different company.</p><button type="button" class="button button-primary" id="emptyAddCompany">Search unlisted company</button></div>';
      $('emptyAddCompany').addEventListener('click', () => openCustomCompanyModal(rawQuery));
      return;
    }
    $('directoryCardsGrid').innerHTML = filtered.map(company => `<article class="panel company-card"><div><div class="company-card-top">${logoMarkup(company)}</div><h3>${escapeStr(company.name)}</h3></div><button type="button" class="button button-primary" data-start-case="${escapeStr(company.id)}">Submit a case <span aria-hidden="true">→</span></button></article>`).join('');
  }

  function updateHeaderCounts() {
    $('headerCaseCount').textContent = cases.length;
    $('headerCaseCount').setAttribute('aria-label', `${cases.length} saved ${cases.length === 1 ? 'case' : 'cases'}`);
  }

  function statusPill(status) {
    const classes = { 'Submitted': 'status-submitted', 'In Review': 'status-review', 'Escalated to Company': 'status-escalated', 'Resolved': 'status-resolved' };
    return `<span class="status-pill ${classes[status] || 'status-submitted'}">${escapeStr(status)}</span>`;
  }

  function renderTrackerList() {
    const query = $('trackerSearchInput').value.trim().toLowerCase();
    const status = $('trackerStatusFilter').value;
    const filtered = cases.filter(item => {
      const matches = [item.ref, item.companyName, item.customerName, item.customerPhone].some(value => value.toLowerCase().includes(query));
      return matches && (status === 'ALL' || item.status === status);
    });
    const container = $('trackerResultsList');
    if (!filtered.length) {
      container.innerHTML = `<div class="panel empty-state"><h3>${cases.length ? 'No matching saved cases' : 'No cases saved in this browser yet'}</h3><p>${cases.length ? 'Check the reference or change the current filters.' : 'Submit a case successfully and its reference will appear here on this device.'}</p><button type="button" class="button button-primary" data-view="submit">Submit a case</button></div>`;
      return;
    }
    container.innerHTML = filtered.map(item => `<article class="panel case-card"><div class="case-card-header"><div><span class="case-reference mono">${escapeStr(item.ref)}</span><p>${escapeStr(item.createdAt)} · <button type="button" class="text-button" data-copy-ref="${escapeStr(item.ref)}">Copy reference</button></p></div>${statusPill(item.status)}</div><div class="case-details"><div><h3>${escapeStr(item.companyName)}</h3><p>${escapeStr(item.companyRegion)} · ${escapeStr(item.companySector)}</p><p><strong>Account/order:</strong> ${escapeStr(item.accountRef)}</p><p><strong>Customer:</strong> ${escapeStr(item.customerName)}<br>${escapeStr(item.customerEmail)}<br>${escapeStr(item.customerPhone)}</p></div><div class="case-description"><h3>${escapeStr(item.issueCategory)}</h3><p><strong>Priority:</strong> ${escapeStr(item.priority)}</p><p><strong>Desired resolution:</strong> ${escapeStr(item.resolution)}</p><p>${escapeStr(item.description)}</p></div></div></article>`).join('');
  }

  function renderRecentCases() {
    const container = $('recentCasesSidebar');
    if (!cases.length) {
      container.innerHTML = '<div class="empty-state"><p>No submitted cases saved yet.</p></div>';
      return;
    }
    container.innerHTML = cases.slice(0, 3).map(item => `<button type="button" class="mini-case text-button" data-view="tracker"><span class="mini-case-top"><strong>${escapeStr(item.companyName)}</strong>${statusPill(item.status)}</span><p class="mono">${escapeStr(item.ref)}</p></button>`).join('');
  }

  function showFormError(message) {
    const banner = $('formErrorBanner');
    banner.textContent = message;
    banner.hidden = false;
    banner.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }

  function hideFormError() { $('formErrorBanner').hidden = true; }

  function makeReference() {
    const year = new Date().getFullYear();
    let reference;
    do {
      let number;
      if (window.crypto?.getRandomValues) {
        const values = new Uint32Array(1);
        window.crypto.getRandomValues(values);
        number = 10000 + (values[0] % 90000);
      } else number = Math.floor(10000 + Math.random() * 90000);
      reference = `GIR-${year}-${number}`;
    } while (cases.some(item => item.ref === reference));
    return reference;
  }

  async function submitCustomerCase(event) {
    event.preventDefault();
    const form = event.currentTarget;
    hideFormError();
    if (!selectedCompany) {
      showFormError('Select a company from the search results, or add an unlisted company using its official website.');
      $('companySearchInput').focus();
      return;
    }
    if (!form.checkValidity()) {
      showFormError('Complete every required field with valid details and accept the submission notice.');
      form.reportValidity();
      return;
    }
    const phoneDigits = $('custPhone').value.replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      showFormError('Enter a valid phone number containing 7 to 15 digits, without the country code.');
      $('custPhone').focus();
      return;
    }
    if (form.elements.botcheck.checked) return;

    const submitButton = $('submitCaseBtn');
    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    $('submitCaseBtnText').textContent = 'Delivering case…';

    const reference = makeReference();
    const fullPhone = `${$('custDialCode').value} ${$('custPhone').value.trim()}`;
    const submittedAt = new Date();
    const newCase = {
      ref: reference,
      companyName: selectedCompany.name,
      companyRegion: selectedCompany.region,
      companySector: selectedCompany.sector,
      customerName: $('custName').value.trim(),
      customerEmail: $('custEmail').value.trim(),
      customerPhone: fullPhone,
      accountRef: $('custAccount').value.trim() || 'N/A',
      issueCategory: $('issueType').value,
      priority: $('issuePriority').value,
      resolution: $('desiredResolution').value.trim(),
      description: $('issueDescription').value.trim(),
      status: 'Submitted',
      createdAt: submittedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    };

    const deliveryController = new AbortController();
    const deliveryTimeout = setTimeout(() => deliveryController.abort(), 20000);
    try {
      const formData = new FormData(form);
      formData.append('subject', `New GetItResolved Case [${reference}] — ${selectedCompany.name}`);
      formData.append('replyto', newCase.customerEmail);
      formData.append('Case Reference ID', reference);
      formData.append('Company Domain', selectedCompany.domain);
      formData.append('Company Region', selectedCompany.region);
      formData.append('Phone Number', fullPhone);
      formData.append('Submitted ISO Date', submittedAt.toISOString());

      const response = await fetch('https://api.web3forms.com/submit', { method: 'POST', body: formData, signal: deliveryController.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success === false) throw new Error(result.message || `Delivery failed with status ${response.status}`);

      latestCase = newCase;
      cases.unshift(newCase);
      writeStorage(STORAGE.cases, cases);
      updateHeaderCounts();
      renderTrackerList();
      renderRecentCases();
      populateConfirmation(newCase);
      form.reset();
      clearSelectedCompany(false);
      openModal($('confirmationModal'));
      notifyToast('Case delivered and saved in this browser.', 'success');
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'The delivery timed out.' : (error.message || 'The delivery service could not be reached.');
      showFormError(`We could not deliver your case, so no reference was created. Check your connection and try again. ${reason}`);
    } finally {
      clearTimeout(deliveryTimeout);
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      $('submitCaseBtnText').textContent = 'Submit case & get reference';
    }
  }

  function populateConfirmation(item) {
    $('modalRefNumber').textContent = item.ref;
    $('modalCompanyName').textContent = `${item.companyName} (${item.companyRegion})`;
    $('modalCustomerName').textContent = item.customerName;
    $('modalCustomerPhone').textContent = item.customerPhone;
    $('modalIssueType').textContent = item.issueCategory;
    $('modalSubmittedDate').textContent = item.createdAt;
  }

  function quickAddCompany(rawName) {
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (name.length < 2) return;
    const existing = companies.find(company => normalizeCompanyQuery(company.name) === normalizeCompanyQuery(name));
    if (existing) { selectCompany(existing.id); return; }
    selectCompany({
      id: `manual_${Date.now()}`, name, domain: '',
      sector: 'Customer Service & Support', region: 'Global',
      logo: DEFAULT_LOGO, custom: false
    });
    notifyToast('Name-only selection. No verified company logo was found.');
  }

  function openCustomCompanyModal(prefill = '') {
    $('customCompanyError').hidden = true;
    $('customCompName').value = prefill;
    openModal($('customCompanyModal'));
  }

  async function saveCustomCompany(event) {
    event.preventDefault();
    const name = $('customCompName').value.trim();
    const error = $('customCompanyError');
    const submitButton = $('customCompanyForm').querySelector('button[type="submit"]');
    error.hidden = true;
    if (name.length < 2) {
      error.textContent = 'Enter at least two characters to search.';
      error.hidden = false;
      $('customCompName').focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    submitButton.textContent = 'Searching…';
    try {
      const found = mergeRemoteCompanies(await searchRemoteCompanies(name));
      const exact = found.filter(company => normalizeCompanyQuery(company.name) === normalizeCompanyQuery(name));
      if (exact.length === 1) {
        $('customCompanyForm').reset();
        closeModal($('customCompanyModal'));
        switchView('submit');
        selectCompany(exact[0].id);
        notifyToast('Verified company found and selected.', 'success');
        return;
      }
      if (found.length) {
        $('customCompanyForm').reset();
        closeModal($('customCompanyModal'));
        switchView('submit');
        $('companySearchInput').value = name;
        renderCompanyDropdown(found, name);
        openCompanyDropdown();
        notifyToast('Several verified matches were found. Choose the correct company.');
        return;
      }
      error.textContent = 'No verified company match was found. You can still submit using the name only from the company search.';
      error.hidden = false;
    } catch {
      error.textContent = 'Company search is temporarily unavailable. Try again or use the name-only option in the company search.';
      error.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      submitButton.textContent = 'Search company names';
    }
  }

  function openModal(modal) {
    lastFocusedElement = document.activeElement;
    activeModal = modal;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const focusTarget = modal.id === 'confirmationModal' ? $('copyReference') : $('customCompName');
    focusTarget.focus();
  }

  function closeModal(modal) {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    activeModal = null;
    document.body.style.overflow = '';
    if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
  }

  function handleModalKeyboard(event) {
    if (!activeModal) return;
    if (event.key === 'Escape') { event.preventDefault(); closeModal(activeModal); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...activeModal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function copyText(text, successMessage = 'Copied.') {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        textarea.remove();
      }
    } catch (_) { copied = false; }
    notifyToast(copied ? successMessage : `Copy manually: ${text}`, copied ? 'success' : 'default');
  }

  function notifyToast(message, tone = 'default') {
    const toast = document.createElement('div');
    toast.className = `toast ${tone === 'success' ? 'success' : ''}`;
    toast.textContent = message;
    $('toastBox').appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
