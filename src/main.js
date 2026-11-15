(() => {
  'use strict';

  const STORAGE = { cases: 'gir_cases_v3', companies: 'gir_custom_companies_v3' };
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

  function normalizeCustomCompany(item) {
    if (!item || typeof item !== 'object' || !item.id || !item.name) return null;
    const domain = cleanText(item.domain).slice(0, 255);
    return {
      id: cleanText(item.id).replace(/[^a-zA-Z0-9_-]/g, ''),
      name: cleanText(item.name).slice(0, 120), domain,
      sector: cleanText(item.sector, 'Customer Service & Support'), region: cleanText(item.region, 'Global'),
      logo: cleanText(item.logo, domain ? `https://logo.uplead.com/${domain}` : DEFAULT_LOGO), custom: true
    };
  }

  function initApp() {
    cases = readStorage(STORAGE.cases).map(normalizeCase).filter(Boolean);
    const customCompanies = readStorage(STORAGE.companies).map(normalizeCustomCompany).filter(Boolean);
    companies = [...customCompanies, ...GLOBAL_COMPANIES];

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
      else {
        $('companySearchInput').value = deepCompany;
        renderCompanyDropdown([], deepCompany);
        notifyToast('That company is not listed. Add its official website to continue.');
      }
    }

    const initialHash = window.location.hash.slice(1);
    if (initialHash === 'faq') switchView('submit', { updateHash: false, scroll: false });
    else switchView(VIEWS.includes(initialHash) ? initialHash : 'submit', { updateHash: false, scroll: false });
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
      if (event.key === 'Enter' && !$('companyDropdownList').hidden) {
        const typed = event.target.value.trim();
        const exact = companies.find(company => company.name.toLowerCase() === typed.toLowerCase());
        if (exact) { event.preventDefault(); selectCompany(exact.id); }
        else if (typed.length > 1) { event.preventDefault(); quickAddCompany(typed); }
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
      const customButton = event.target.closest('[data-custom-name]');
      if (companyButton) selectCompany(companyButton.dataset.companyId);
      if (quickButton) quickAddCompany(quickButton.dataset.quickName);
      if (customButton) openCustomCompanyModal(customButton.dataset.customName);
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
      if (image.dataset.fallback) {
        const fallback = image.dataset.fallback;
        delete image.dataset.fallback;
        image.src = fallback;
      } else if (image.id === 'selCompLogoImg') {
        // Never remove this element: selectCompany() reuses it for the next selection.
        if (!image.src.endsWith('/assets/favicon.svg')) image.src = DEFAULT_LOGO;
      } else {
        const frame = image.closest('.logo-frame');
        if (frame) frame.innerHTML = '<span class="logo-unavailable">Logo unavailable</span>';
      }
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

  function logoMarkup(company, eager = false) {
    const fallback = company.custom && company.domain ? `https://icon.horse/icon/${encodeURIComponent(company.domain)}` : '';
    return `<span class="logo-frame"><img src="${escapeStr(company.logo || DEFAULT_LOGO)}" alt="${escapeStr(company.name)} logo" width="40" height="40" ${eager ? '' : 'loading="lazy"'} decoding="async" data-company-logo ${fallback ? `data-fallback="${escapeStr(fallback)}"` : ''}></span>`;
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
    const query = $('companySearchInput').value.trim().toLowerCase();
    const filtered = companies.filter(company => [company.name, company.sector, company.region, company.domain].some(value => String(value || '').toLowerCase().includes(query)));
    renderCompanyDropdown(filtered, query);
    if (open) {
      $('companyDropdownList').hidden = false;
      $('companySearchInput').setAttribute('aria-expanded', 'true');
    }
  }

  function renderCompanyDropdown(list, rawQuery = '') {
    const menu = $('companyDropdownList');
    const safeQuery = rawQuery.trim();
    const hasExact = companies.some(company => company.name.toLowerCase() === safeQuery.toLowerCase());
    const custom = safeQuery.length > 1 && !hasExact ? `<div class="dropdown-custom"><p>Can’t find <strong>“${escapeStr(safeQuery)}”</strong>? You can still submit a case.</p><button type="button" class="button button-primary" data-quick-name="${escapeStr(safeQuery)}">Use “${escapeStr(safeQuery)}” &amp; continue</button> <button type="button" class="button button-secondary" data-custom-name="${escapeStr(safeQuery)}">Add with website &amp; logo</button></div>` : '';
    const options = list.slice(0, 80).map(company => `<button type="button" class="company-option" role="option" data-company-id="${escapeStr(company.id)}"><span class="company-option-main">${logoMarkup(company)}<span class="company-option-copy"><span class="company-option-name">${escapeStr(company.name)}</span><span class="company-option-meta">${escapeStr(company.region)} · ${escapeStr(company.sector)}</span></span></span><span class="option-action">Select →</span></button>`).join('');
    menu.innerHTML = custom + (options || '<div class="empty-dropdown">No listed companies match. Use the button above to submit a case against any company.</div>');
  }

  function selectCompany(companyId) {
    const company = companies.find(item => item.id === companyId);
    if (!company) return;
    selectedCompany = company;
    $('companySearchInput').value = company.name;
    closeCompanyDropdown();
    hideFormError();
    $('selectedCompanyBanner').hidden = false;
    const image = $('selCompLogoImg');
    image.src = company.logo || DEFAULT_LOGO;
    image.alt = `${company.name} logo`;
    image.dataset.companyLogo = '';
    if (company.custom && company.domain) image.dataset.fallback = `https://icon.horse/icon/${encodeURIComponent(company.domain)}`;
    else delete image.dataset.fallback;
    $('selCompName').textContent = company.name;
    $('selCompMeta').textContent = [company.region, company.sector, company.domain].filter(Boolean).join(' · ');
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
    $('trendingCompaniesSidebar').innerHTML = trending.map(company => `<button type="button" class="company-list-item" data-select-company="${escapeStr(company.id)}"><span class="company-line">${logoMarkup(company, true)}<span class="company-copy"><span class="company-name">${escapeStr(company.name)}</span><span class="company-meta">${escapeStr(company.region)}</span></span></span><span class="list-select">Select</span></button>`).join('');
  }

  function renderDirectoryGrid() {
    const query = $('dirSearch').value.trim().toLowerCase();
    const region = $('dirRegion').value;
    const sector = $('dirSector').value;
    const filtered = companies.filter(company => {
      const matchesQuery = [company.name, company.sector, company.region, company.domain].some(value => String(value || '').toLowerCase().includes(query));
      return matchesQuery && (region === 'ALL' || company.region === region) && (sector === 'ALL' || company.sector === sector);
    });
    $('directoryResultCount').textContent = `${filtered.length.toLocaleString('en-GB')} ${filtered.length === 1 ? 'company' : 'companies'} found`;
    if (!filtered.length) {
      $('directoryCardsGrid').innerHTML = '<div class="empty-state"><h3>No companies match these filters</h3><p>Clear a filter or add the company using its official website.</p><button type="button" class="button button-primary" id="emptyAddCompany">Add unlisted company</button></div>';
      $('emptyAddCompany').addEventListener('click', () => openCustomCompanyModal($('dirSearch').value.trim()));
      return;
    }
    $('directoryCardsGrid').innerHTML = filtered.map(company => `<article class="panel company-card"><div><div class="company-card-top">${logoMarkup(company)}<span class="region-tag">${escapeStr(company.region)}</span></div><h3>${escapeStr(company.name)}</h3><p>${escapeStr(company.sector)}${company.domain ? `<br>${escapeStr(company.domain)}` : ''}</p></div><button type="button" class="button button-primary" data-start-case="${escapeStr(company.id)}">Submit a case <span aria-hidden="true">→</span></button></article>`).join('');
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
    const existing = companies.find(company => company.name.toLowerCase() === name.toLowerCase());
    if (existing) { selectCompany(existing.id); return; }
    const company = {
      id: `custom_${Date.now()}`, name, domain: '',
      sector: 'Customer Service & Support', region: 'Global',
      logo: DEFAULT_LOGO, custom: true
    };
    companies.unshift(company);
    writeStorage(STORAGE.companies, companies.filter(item => item.custom));
    renderDirectoryGrid();
    selectCompany(company.id);
    notifyToast(`“${name}” added. You can now submit your case.`, 'success');
  }

  function openCustomCompanyModal(prefill = '') {
    $('customCompanyError').hidden = true;
    if (prefill) $('customCompName').value = prefill;
    openModal($('customCompanyModal'));
  }

  function saveCustomCompany(event) {
    event.preventDefault();
    const name = $('customCompName').value.trim();
    const website = $('customCompWebsite').value.trim();
    const error = $('customCompanyError');
    error.hidden = true;
    let domain = '';
    if (website) {
      try {
        const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
        if (!url.hostname.includes('.')) throw new Error('Invalid website');
        domain = url.hostname.toLowerCase().replace(/^www\./, '');
      } catch (_) {
        error.textContent = 'Enter a valid website such as https://www.example.com, or leave it blank.';
        error.hidden = false;
        $('customCompWebsite').focus();
        return;
      }
    }
    const socialDomains = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'linktr.ee'];
    if (domain && socialDomains.some(blocked => domain === blocked || domain.endsWith(`.${blocked}`))) {
      error.textContent = 'Use the company’s own website domain rather than a social-media or link-directory page.';
      error.hidden = false;
      return;
    }
    if (!name) {
      error.textContent = 'Enter the company name.';
      error.hidden = false;
      return;
    }
    const existing = companies.find(company => (domain && company.domain === domain) || company.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      closeModal($('customCompanyModal'));
      switchView('submit');
      selectCompany(existing.id);
      notifyToast('That company is already listed and has been selected.', 'success');
      return;
    }
    const company = {
      id: `custom_${Date.now()}`, name, domain,
      sector: $('customCompSector').value, region: $('customCompRegion').value,
      logo: domain ? `https://logo.uplead.com/${encodeURIComponent(domain)}` : DEFAULT_LOGO, custom: true
    };
    companies.unshift(company);
    const customCompanies = companies.filter(item => item.custom);
    writeStorage(STORAGE.companies, customCompanies);
    renderDirectoryGrid();
    $('customCompanyForm').reset();
    closeModal($('customCompanyModal'));
    switchView('submit');
    selectCompany(company.id);
    notifyToast('Company added. You can now submit your case.', 'success');
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
