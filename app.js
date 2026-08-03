'use strict';

(() => {
  const {
    DEVICE_PROFILES,
    getDeviceProfile,
    IntelHexImage,
    UpdiProgrammer,
    parseByteValue,
    hexByte,
    hexWord,
    bytesToHex,
  } = window.WebUpdi;

  const DEFAULT_DEVICE = getDeviceProfile('attiny814');

  const DEFAULT_PROFILE = Object.freeze({
    target: DEFAULT_DEVICE.key,
    targetLabel: DEFAULT_DEVICE.label,
    baudRate: 460800,
    writeDelayMs: 1,
    verify: true,
    assertSignals: true,
    fuses: Object.freeze({
      0: 0x00,
      2: 0x01,
      6: 0x04,
      7: 0x00,
      8: 0x00,
    }),
  });

  const CUSTOM_BADGE = {
    id: 'custom-hex',
    custom: true,
    enabled: true,
    name: 'Custom HEX file',
    family: 'Local firmware',
    description: 'Choose an Intel HEX file from this computer and flash it without uploading the firmware anywhere.',
    image: null,
    firmware: null,
    firmwareSource: null,
    version: 'Local file',
    released: '',
    target: DEFAULT_PROFILE.target,
    targetLabel: DEFAULT_PROFILE.targetLabel,
    tags: ['Your firmware', 'Local only', 'Select target'],
    baudRate: DEFAULT_PROFILE.baudRate,
    writeDelayMs: DEFAULT_PROFILE.writeDelayMs,
    verify: DEFAULT_PROFILE.verify,
    assertSignals: DEFAULT_PROFILE.assertSignals,
    fuses: DEFAULT_PROFILE.fuses,
  };

  const elements = {
    supportBanner: document.querySelector('#support-banner'),
    badgeGrid: document.querySelector('#badge-grid'),
    catalogueCount: document.querySelector('#catalogue-count'),
    catalogueError: document.querySelector('#catalogue-error'),
    selectedSection: document.querySelector('#selected-section'),
    changeBadge: document.querySelector('#change-badge'),
    selectedImage: document.querySelector('#selected-image'),
    selectedImageFallback: document.querySelector('#selected-image-fallback'),
    selectedEyebrow: document.querySelector('#selected-eyebrow'),
    selectedName: document.querySelector('#selected-name'),
    selectedDescription: document.querySelector('#selected-description'),
    selectedTags: document.querySelector('#selected-tags'),
    firmwareState: document.querySelector('#firmware-state'),
    firmwareFile: document.querySelector('#firmware-file'),
    firmwareVersion: document.querySelector('#firmware-version'),
    firmwareTarget: document.querySelector('#firmware-target'),
    firmwareSize: document.querySelector('#firmware-size'),
    firmwareMessage: document.querySelector('#firmware-message'),
    customFileActions: document.querySelector('#custom-file-actions'),
    chooseCustomHex: document.querySelector('#choose-custom-hex'),
    customTarget: document.querySelector('#custom-target'),
    customHexInput: document.querySelector('#custom-hex-input'),
    choosePort: document.querySelector('#choose-port'),
    portStatus: document.querySelector('#port-status'),
    identify: document.querySelector('#identify'),
    flash: document.querySelector('#flash'),
    cancel: document.querySelector('#cancel'),
    actionHelp: document.querySelector('#action-help'),
    status: document.querySelector('#status'),
    progress: document.querySelector('#progress'),
    progressLabel: document.querySelector('#progress-label'),
    baudRate: document.querySelector('#baud-rate'),
    writeDelay: document.querySelector('#write-delay'),
    verify: document.querySelector('#verify'),
    assertSignals: document.querySelector('#assert-signals'),
    fuseSummary: document.querySelector('#fuse-summary'),
    log: document.querySelector('#log'),
    clearLog: document.querySelector('#clear-log'),
    downloadLog: document.querySelector('#download-log'),
  };

  let badges = [];
  let selectedBadge = null;
  let selectedFirmware = null;
  let selectedFirmwareText = null;
  let selectedPort = null;
  let selectedCustomFileName = null;
  let firmwareAbortController = null;
  let busy = false;
  let cancelRequested = false;
  let webSerialSupported = false;

  function timestamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function log(message, type = 'info') {
    const line = document.createElement('div');
    line.className = `log-line log-${type}`;
    line.textContent = `[${timestamp()}] ${message}`;
    elements.log.appendChild(line);
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function setStatus(message, type = 'neutral') {
    elements.status.textContent = message;
    elements.status.dataset.type = type;
  }

  function setProgress(value, label) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    elements.progress.value = percent;
    elements.progress.textContent = `${Math.round(percent)}%`;
    elements.progressLabel.textContent = label
      ? `${label} — ${Math.round(percent)}%`
      : `${Math.round(percent)}%`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      return '—';
    }
    if (bytes < 1024) {
      return `${bytes.toLocaleString()} bytes`;
    }
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
  }

  function fileNameFromUrl(value) {
    if (!value) {
      return '—';
    }
    try {
      const url = new URL(value, document.baseURI);
      return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || value);
    } catch (_) {
      return String(value).split('/').pop();
    }
  }

  function normaliseFuses(rawFuses) {
    const source = rawFuses && typeof rawFuses === 'object'
      ? rawFuses
      : DEFAULT_PROFILE.fuses;
    const result = {};

    for (const [index, value] of Object.entries(source)) {
      result[Number(index)] = parseByteValue(value);
    }

    return result;
  }

  function fuseSummary(fuses) {
    return Object.entries(fuses)
      .map(([index, value]) => [Number(index), Number(value)])
      .sort((a, b) => a[0] - b[0])
      .map(([index, value]) => `${index}:${hexByte(value)}`)
      .join(' · ');
  }

  function resolveFromFolder(folderUrl, value) {
    if (!value) {
      return null;
    }
    return new URL(value, folderUrl).href;
  }

  function normaliseBadge(folder, config) {
    const folderUrl = new URL(folder.endsWith('/') ? folder : `${folder}/`, document.baseURI);
    const fuses = normaliseFuses(config.fuses);
    const device = getDeviceProfile(config.target || DEFAULT_PROFILE.target);

    return {
      id: String(config.id || folder.replace(/[^a-z0-9]+/gi, '-')).toLowerCase(),
      folder,
      folderUrl: folderUrl.href,
      name: String(config.name || 'Unnamed badge'),
      family: String(config.family || 'Electronic badge'),
      description: String(config.description || 'No badge description has been supplied.'),
      image: resolveFromFolder(folderUrl, config.image || 'badge.jpg'),
      firmware: resolveFromFolder(folderUrl, config.firmware || 'firmware.hex'),
      firmwareSource: config.firmware || 'firmware.hex',
      version: String(config.version || 'Unversioned'),
      released: config.released ? String(config.released) : '',
      target: device.key,
      targetLabel: device.label,
      tags: Array.isArray(config.tags) ? config.tags.map(String) : [],
      enabled: config.enabled !== false,
      baudRate: Number(config.baudRate || DEFAULT_PROFILE.baudRate),
      writeDelayMs: Number.isFinite(Number(config.writeDelayMs))
        ? Number(config.writeDelayMs)
        : DEFAULT_PROFILE.writeDelayMs,
      verify: config.verify !== false,
      assertSignals: config.assertSignals !== false,
      fuses,
    };
  }

  async function loadBadgeConfig(folder) {
    const folderPath = typeof folder === 'string' ? folder : folder.folder;
    if (!folderPath) {
      throw new Error('Catalogue entry is missing its folder path');
    }

    const configUrl = new URL(
      `${folderPath.replace(/\/$/, '')}/badge.json`,
      document.baseURI
    );
    const response = await fetch(configUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`${configUrl.pathname}: HTTP ${response.status}`);
    }

    const config = await response.json();
    return normaliseBadge(folderPath, config);
  }

  function createBadgeCard(badge) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `badge-card${badge.enabled ? '' : ' unavailable'}`;
    button.dataset.badgeId = badge.id;
    button.setAttribute('aria-label', `Select ${badge.name}`);

    const imageWrap = document.createElement('div');
    imageWrap.className = `badge-card-image${badge.custom ? ' custom-file-card' : ''}`;

    if (badge.custom) {
      const icon = document.createElement('div');
      icon.className = 'custom-file-icon';
      icon.setAttribute('aria-hidden', 'true');
      const fold = document.createElement('span');
      fold.className = 'custom-file-fold';
      const label = document.createElement('strong');
      label.textContent = 'HEX';
      const prompt = document.createElement('small');
      prompt.textContent = 'Choose a local file';
      icon.append(fold, label);
      imageWrap.append(icon, prompt);
    } else {
      const image = document.createElement('img');
      image.src = badge.image;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        image.remove();
        imageWrap.textContent = 'BADGE IMAGE';
      }, { once: true });
      imageWrap.appendChild(image);
    }

    const content = document.createElement('div');
    content.className = 'badge-card-content';

    const kicker = document.createElement('div');
    kicker.className = 'badge-card-kicker';
    const family = document.createElement('span');
    family.textContent = badge.family;
    const availability = document.createElement('span');
    availability.textContent = badge.custom
      ? 'Choose file'
      : (badge.enabled ? badge.version : 'Template');
    kicker.append(family, availability);

    const title = document.createElement('h3');
    title.textContent = badge.name;
    const description = document.createElement('p');
    description.textContent = badge.description;

    const tags = document.createElement('div');
    tags.className = 'card-tags';
    for (const tag of badge.tags.slice(0, 3)) {
      const item = document.createElement('span');
      item.textContent = tag;
      tags.appendChild(item);
    }

    content.append(kicker, title, description, tags);
    button.append(imageWrap, content);
    button.addEventListener('click', () => selectBadge(badge.id));
    return button;
  }

  function renderCatalogue() {
    elements.badgeGrid.replaceChildren();
    elements.catalogueError.hidden = true;

    if (badges.length === 0) {
      elements.catalogueCount.textContent = '0 badges';
      elements.catalogueError.hidden = false;
      elements.catalogueError.textContent =
        'No badge definitions were loaded. Add a badge folder and list it in badges.json.';
      return;
    }

    for (const badge of badges) {
      elements.badgeGrid.appendChild(createBadgeCard(badge));
    }

    const hostedReadyCount = badges.filter((badge) => badge.enabled && !badge.custom).length;
    elements.catalogueCount.textContent =
      `${badges.length} option${badges.length === 1 ? '' : 's'} · ${hostedReadyCount} hosted firmware`;
  }

  async function loadCatalogue() {
    elements.catalogueCount.textContent = 'Loading catalogue…';

    try {
      const response = await fetch(new URL('badges.json', document.baseURI), {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`badges.json returned HTTP ${response.status}`);
      }

      const manifest = await response.json();
      const entries = Array.isArray(manifest) ? manifest : manifest.badges;
      if (!Array.isArray(entries)) {
        throw new Error('badges.json must contain a "badges" array');
      }

      const results = await Promise.allSettled(entries.map(loadBadgeConfig));
      badges = [
        CUSTOM_BADGE,
        ...results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value),
      ];

      for (const result of results) {
        if (result.status === 'rejected') {
          log(`Badge definition skipped: ${result.reason.message}`, 'warn');
        }
      }

      renderCatalogue();
      log(`Loaded ${badges.length - 1} hosted badge definition(s) plus the custom HEX option.`, 'success');
    } catch (error) {
      badges = [CUSTOM_BADGE];
      renderCatalogue();
      elements.catalogueCount.textContent = 'Custom HEX available · hosted catalogue unavailable';
      elements.catalogueError.hidden = false;
      elements.catalogueError.textContent =
        `Hosted badges could not be loaded: ${error.message}. The custom HEX option still works when the site is served over HTTPS or localhost.`;
      log(`Catalogue load failed: ${error.message}`, 'error');
    }
  }

  function markSelectedCard() {
    for (const card of elements.badgeGrid.querySelectorAll('.badge-card')) {
      card.classList.toggle(
        'selected',
        Boolean(selectedBadge && card.dataset.badgeId === selectedBadge.id)
      );
    }
  }

  function renderTags(tags) {
    elements.selectedTags.replaceChildren();
    for (const tag of tags) {
      const item = document.createElement('span');
      item.textContent = tag;
      elements.selectedTags.appendChild(item);
    }
  }

  function setFirmwareState(label, stateClass) {
    elements.firmwareState.textContent = label;
    elements.firmwareState.className = `status-chip ${stateClass || ''}`.trim();
  }

  function showSelectedImage(badge) {
    if (badge.custom) {
      elements.selectedImage.hidden = true;
      elements.selectedImage.removeAttribute('src');
      elements.selectedImage.alt = '';
      elements.selectedImageFallback.hidden = false;
      elements.selectedImageFallback.textContent = 'HEX';
      elements.selectedImageFallback.classList.add('custom-hex-fallback');
      return;
    }

    elements.selectedImageFallback.classList.remove('custom-hex-fallback');
    elements.selectedImageFallback.textContent = 'BADGE';
    elements.selectedImage.hidden = false;
    elements.selectedImageFallback.hidden = true;
    elements.selectedImage.src = badge.image;
    elements.selectedImage.alt = badge.name;
  }

  function updateSettingsFromBadge(badge) {
    elements.baudRate.value = String(badge.baudRate);
    if (!elements.baudRate.value) {
      elements.baudRate.value = String(DEFAULT_PROFILE.baudRate);
    }
    elements.writeDelay.value = String(badge.writeDelayMs);
    elements.verify.checked = badge.verify;
    elements.assertSignals.checked = badge.assertSignals;
    elements.fuseSummary.textContent = fuseSummary(badge.fuses);
  }

  async function sha256Short(text) {
    if (!window.crypto || !window.crypto.subtle) {
      return null;
    }
    const bytes = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  }

  function openCustomHexPicker() {
    if (busy) {
      return;
    }
    elements.customHexInput.value = '';
    elements.customHexInput.click();
  }

  async function validateCustomHexText(text, fileName) {
    if (!selectedBadge || !selectedBadge.custom) {
      return;
    }

    selectedFirmware = null;
    selectedFirmwareText = text;
    selectedCustomFileName = fileName || selectedCustomFileName || 'custom.hex';
    elements.firmwareFile.textContent = selectedCustomFileName;
    elements.firmwareSize.textContent = 'Validating…';
    setFirmwareState('Validating', 'loading');
    elements.firmwareMessage.className = 'firmware-message';
    elements.firmwareMessage.textContent =
      `Validating the local Intel HEX image for ${selectedBadge.targetLabel}…`;
    updateActionState();

    try {
      const image = IntelHexImage.parse(text, selectedBadge.target);
      const shortHash = await sha256Short(text);

      if (!selectedBadge || !selectedBadge.custom) {
        return;
      }

      selectedFirmware = image;
      setFirmwareState('Ready', 'ready');
      elements.firmwareSize.textContent =
        `${formatBytes(image.dataByteCount)} · ${image.programmedPageCount} pages`;
      elements.firmwareMessage.className = 'firmware-message good';
      elements.firmwareMessage.textContent =
        `Local Intel HEX validated for ${image.device.label}: ` +
        `${image.dataByteCount.toLocaleString()} data bytes, ` +
        `${image.spanBytes.toLocaleString()}-byte flash span, last address ${hexWord(image.lastAddress)}` +
        `${shortHash ? `, SHA-256 ${shortHash}…` : ''}. The file has not left this browser tab.`;
      setStatus(`Custom HEX ready for ${image.device.label}`, 'good');
      log(
        `Custom firmware ready for ${image.device.label}: ${selectedCustomFileName}, ` +
        `${image.dataByteCount} data bytes.`,
        'success'
      );
    } catch (error) {
      selectedFirmware = null;
      setFirmwareState('Invalid', 'error');
      elements.firmwareSize.textContent = 'Validation failed';
      elements.firmwareMessage.className = 'firmware-message bad';
      elements.firmwareMessage.textContent =
        `The selected HEX file is not valid for ${selectedBadge.targetLabel}: ${error.message}`;
      setStatus('Custom HEX validation failed', 'bad');
      log(
        `Custom HEX validation failed for ${selectedBadge.targetLabel} ` +
        `(${selectedCustomFileName}): ${error.message}`,
        'error'
      );
    }

    updateActionState();
  }

  async function loadCustomHexFile(file) {
    if (!file || !selectedBadge || !selectedBadge.custom) {
      return;
    }

    selectedCustomFileName = file.name || 'custom.hex';
    elements.firmwareFile.textContent = selectedCustomFileName;

    try {
      const text = await file.text();
      await validateCustomHexText(text, selectedCustomFileName);
    } catch (error) {
      selectedFirmware = null;
      selectedFirmwareText = null;
      setFirmwareState('Invalid', 'error');
      elements.firmwareSize.textContent = 'Read failed';
      elements.firmwareMessage.className = 'firmware-message bad';
      elements.firmwareMessage.textContent = `The selected file could not be read: ${error.message}`;
      setStatus('Custom HEX file could not be read', 'bad');
      log(`Could not read ${selectedCustomFileName}: ${error.message}`, 'error');
      updateActionState();
    }
  }

  async function updateCustomTarget() {
    if (busy || !selectedBadge || !selectedBadge.custom) {
      return;
    }

    const device = getDeviceProfile(elements.customTarget.value);
    selectedBadge.target = device.key;
    selectedBadge.targetLabel = device.label;
    selectedBadge.tags = ['Your firmware', 'Local only', device.label];
    elements.firmwareTarget.textContent = device.label;
    renderTags(selectedBadge.tags);
    updateSettingsFromBadge(selectedBadge);
    log(`Custom firmware target changed to ${device.label}.`);

    if (selectedFirmwareText) {
      await validateCustomHexText(selectedFirmwareText, selectedCustomFileName);
    } else {
      elements.firmwareMessage.className = 'firmware-message warn';
      elements.firmwareMessage.textContent =
        `Choose an Intel HEX file compiled for the ${device.label}. ` +
        'The file is read locally and is not uploaded to the website.';
      setStatus(`Choose a custom HEX file for ${device.label}`, 'neutral');
      updateActionState();
    }
  }

  async function loadSelectedFirmware(badge) {
    selectedFirmware = null;
    selectedFirmwareText = null;

    if (badge.custom) {
      updateActionState();
      return;
    }

    if (firmwareAbortController) {
      firmwareAbortController.abort();
    }
    firmwareAbortController = new AbortController();

    if (!badge.enabled) {
      setFirmwareState('Template', 'template');
      elements.firmwareSize.textContent = 'Not installed';
      elements.firmwareMessage.className = 'firmware-message warn';
      elements.firmwareMessage.textContent =
        'This example is disabled. Add firmware.hex to the badge folder and set "enabled": true in badge.json.';
      updateActionState();
      return;
    }

    setFirmwareState('Loading', 'loading');
    elements.firmwareSize.textContent = 'Loading…';
    elements.firmwareMessage.className = 'firmware-message';
    elements.firmwareMessage.textContent = 'Downloading and validating the Intel HEX image…';
    updateActionState();

    try {
      const response = await fetch(badge.firmware, {
        cache: 'no-store',
        signal: firmwareAbortController.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${fileNameFromUrl(badge.firmware)}`);
      }

      const text = await response.text();
      const image = IntelHexImage.parse(text, badge.target);
      const shortHash = await sha256Short(text);

      if (!selectedBadge || selectedBadge.id !== badge.id) {
        return;
      }

      selectedFirmwareText = text;
      selectedFirmware = image;
      setFirmwareState('Ready', 'ready');
      elements.firmwareSize.textContent =
        `${formatBytes(image.dataByteCount)} · ${image.programmedPageCount} pages`;
      elements.firmwareMessage.className = 'firmware-message good';
      elements.firmwareMessage.textContent =
        `Intel HEX validated: ${image.dataByteCount.toLocaleString()} data bytes, ` +
        `${image.spanBytes.toLocaleString()}-byte flash span, last address ${hexWord(image.lastAddress)}` +
        `${shortHash ? `, SHA-256 ${shortHash}…` : ''}.`;
      log(`Firmware ready for ${badge.name}: ${image.dataByteCount} data bytes.`, 'success');
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      selectedFirmwareText = null;
      selectedFirmware = null;
      setFirmwareState('Unavailable', 'error');
      elements.firmwareSize.textContent = 'Load failed';
      elements.firmwareMessage.className = 'firmware-message bad';
      elements.firmwareMessage.textContent =
        `Firmware could not be loaded: ${error.message}. Check the firmware path in badge.json.`;
      log(`Firmware load failed for ${badge.name}: ${error.message}`, 'error');
    }

    updateActionState();
  }

  async function selectBadge(id) {
    if (busy) {
      return;
    }

    const badge = badges.find((item) => item.id === id);
    if (!badge) {
      return;
    }

    const retainingCustomFirmware = Boolean(
      badge.custom && selectedBadge && selectedBadge.custom && selectedFirmwareText
    );

    selectedBadge = badge;
    if (!retainingCustomFirmware) {
      selectedFirmware = null;
      selectedFirmwareText = null;
      selectedCustomFileName = null;
    }
    markSelectedCard();

    elements.selectedSection.hidden = false;
    elements.selectedEyebrow.textContent = badge.family;
    elements.selectedName.textContent = badge.name;
    elements.selectedDescription.textContent = badge.description;
    elements.firmwareVersion.textContent = badge.version;
    elements.firmwareTarget.textContent = badge.targetLabel;
    renderTags(badge.tags);
    showSelectedImage(badge);
    updateSettingsFromBadge(badge);
    setProgress(0, 'Idle');

    if (badge.custom) {
      elements.customFileActions.hidden = false;
      elements.customTarget.value = badge.target;
      elements.firmwareFile.textContent = selectedCustomFileName || 'No file selected';

      if (retainingCustomFirmware && selectedFirmware) {
        setFirmwareState('Ready', 'ready');
        setStatus(`Custom HEX ready for ${badge.targetLabel}`, 'good');
        log(`Custom HEX option selected with ${selectedCustomFileName} still loaded.`);
      } else if (retainingCustomFirmware) {
        setFirmwareState('Invalid', 'error');
        setStatus('Custom HEX needs a compatible target selection', 'bad');
      } else {
        elements.firmwareSize.textContent = 'Not selected';
        setFirmwareState('Choose file', 'template');
        elements.firmwareMessage.className = 'firmware-message warn';
        elements.firmwareMessage.textContent =
          `Choose an Intel HEX file compiled for the ${badge.targetLabel}. Select the target above before flashing. The file is read locally and is not uploaded to the website.`;
        setStatus('Choose a custom HEX file', 'neutral');
        log('Selected the custom HEX firmware option.');
      }

      updateActionState();
      elements.selectedSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    elements.customFileActions.hidden = true;
    elements.firmwareFile.textContent = fileNameFromUrl(badge.firmwareSource);
    elements.firmwareSize.textContent = 'Loading…';
    setStatus('Badge selected; connect the serial adapter', 'neutral');
    log(`Selected badge: ${badge.name} (${badge.version}).`);

    await loadSelectedFirmware(badge);
    updateActionState();
    elements.selectedSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function formatPort(port) {
    if (!port) {
      return 'No serial port selected';
    }

    const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
    const parts = ['Serial port selected'];
    if (info.usbVendorId !== undefined) {
      parts.push(`VID ${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}`);
    }
    if (info.usbProductId !== undefined) {
      parts.push(`PID ${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}`);
    }
    return parts.join(' · ');
  }

  function updateActionState() {
    const firmwareReady = Boolean(
      selectedBadge &&
      selectedBadge.enabled &&
      selectedFirmware &&
      selectedFirmware.device &&
      selectedFirmware.device.key === selectedBadge.target
    );

    elements.choosePort.disabled = busy || !webSerialSupported;
    elements.identify.disabled = busy || !selectedPort || !selectedBadge;
    elements.flash.disabled = busy || !selectedPort || !firmwareReady;
    elements.cancel.hidden = !busy;
    elements.baudRate.disabled = busy || !selectedBadge;
    elements.writeDelay.disabled = busy || !selectedBadge;
    elements.verify.disabled = busy || !selectedBadge;
    elements.assertSignals.disabled = busy || !selectedBadge;
    elements.customTarget.disabled = busy || !selectedBadge || !selectedBadge.custom;
    elements.portStatus.textContent = formatPort(selectedPort);
    elements.flash.textContent = selectedBadge && selectedBadge.custom
      ? 'Flash custom HEX'
      : 'Flash selected badge';

    for (const card of elements.badgeGrid.querySelectorAll('.badge-card')) {
      card.disabled = busy;
    }

    if (!selectedBadge) {
      elements.actionHelp.textContent = 'Select a badge and connect the programmer to continue.';
    } else if (selectedBadge.custom && !selectedFirmware) {
      elements.actionHelp.textContent = 'Choose and validate a local Intel HEX file before programming.';
    } else if (!selectedPort) {
      elements.actionHelp.textContent = `${selectedBadge.name} is selected. Choose the SerialUPDI port next.`;
    } else if (!firmwareReady) {
      elements.actionHelp.textContent = 'The programmer is connected, but the selected firmware is not ready.';
    } else {
      elements.actionHelp.textContent = `${selectedBadge.name} is ready to erase, program and verify.`;
    }
  }

  function setBusy(value) {
    busy = value;
    updateActionState();
  }

  async function choosePort() {
    if (!webSerialSupported || busy) {
      return;
    }

    try {
      selectedPort = await navigator.serial.requestPort();
      log(`${formatPort(selectedPort)}.`, 'success');
      setStatus('SerialUPDI adapter selected', 'good');
    } catch (error) {
      if (error.name !== 'NotFoundError') {
        log(`Port selection failed: ${error.message}`, 'error');
        setStatus('Could not select serial port', 'bad');
      }
    }

    updateActionState();
  }

  function programmerOptions() {
    const baudRate = Number(elements.baudRate.value);
    const writeDelayMs = Number(elements.writeDelay.value);

    if (!Number.isFinite(baudRate) || baudRate <= 0) {
      throw new Error('Select a valid UPDI baud rate');
    }
    if (!Number.isFinite(writeDelayMs) || writeDelayMs < 0 || writeDelayMs > 50) {
      throw new Error('Page-write delay must be between 0 and 50 ms');
    }

    return {
      device: selectedBadge.target,
      baudRate,
      writeDelayMs,
      verify: elements.verify.checked,
      assertSignals: elements.assertSignals.checked,
      log: (message) => log(message),
      progress: setProgress,
      isCancelled: () => cancelRequested,
    };
  }

  async function runIdentify() {
    if (!selectedPort || !selectedBadge || busy) {
      return;
    }

    cancelRequested = false;
    elements.cancel.disabled = false;
    setBusy(true);
    setProgress(0, 'Starting identification');
    setStatus(`Communicating with ${selectedBadge.targetLabel}…`, 'working');
    log(`Checking the target for ${selectedBadge.name}.`);

    let programmer;
    try {
      programmer = new UpdiProgrammer(selectedPort, programmerOptions());
      const result = await programmer.identify();
      const fuseText = Object.entries(result.fuses)
        .map(([index, value]) => `${index}:${hexByte(value)}`)
        .join('  ');
      log(`${selectedBadge.targetLabel} ID ${bytesToHex(result.id)}. Current fuses: ${fuseText}.`, 'success');
      setStatus(`${selectedBadge.targetLabel} identified successfully`, 'good');
    } catch (error) {
      log(`Identification failed: ${error.message}`, 'error');
      console.error(error);
      setStatus('Identification failed', 'bad');
      setProgress(0, 'Identification failed');
    } finally {
      setBusy(false);
    }
  }

  async function runFlash() {
    if (!selectedPort || !selectedBadge || !selectedFirmware || busy) {
      return;
    }

    const firmwareLabel = selectedBadge.custom
      ? (selectedCustomFileName || 'custom HEX file')
      : `${selectedBadge.name} (${selectedBadge.version})`;
    const confirmed = window.confirm(
      `Flash ${firmwareLabel}?\n\n` +
      `This will erase the ${selectedBadge.targetLabel}, write the selected firmware and update its fuses.`
    );
    if (!confirmed) {
      return;
    }

    cancelRequested = false;
    elements.cancel.disabled = false;
    setBusy(true);
    setProgress(0, 'Preparing');
    setStatus(`Flashing ${selectedBadge.name}…`, 'working');
    log(`Starting flash of ${selectedBadge.custom ? selectedCustomFileName : `${selectedBadge.name} ${selectedBadge.version}`}.`);
    log(`Target: ${selectedBadge.targetLabel}.`);
    log(
      `Settings: ${elements.baudRate.value} baud, ${elements.writeDelay.value} ms page delay, ` +
      `${elements.verify.checked ? 'verify enabled' : 'verify disabled'}.`
    );
    log(`Fuses: ${fuseSummary(selectedBadge.fuses)}.`);

    try {
      const programmer = new UpdiProgrammer(selectedPort, programmerOptions());
      const result = await programmer.program(selectedFirmware, selectedBadge.fuses);
      setStatus(`${selectedBadge.name} flashed successfully`, 'good');
      log(`Success: wrote ${result.pagesWritten} flash page(s).`, 'success');
    } catch (error) {
      const cancelled = error.message === 'Operation cancelled';
      log(
        `${cancelled ? 'Cancelled' : 'Programming failed'}: ${error.message}`,
        cancelled ? 'warn' : 'error'
      );
      console.error(error);
      setStatus(
        cancelled ? 'Programming cancelled' : 'Programming failed',
        cancelled ? 'neutral' : 'bad'
      );
      setProgress(0, cancelled ? 'Cancelled' : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  function downloadLog() {
    const text = Array.from(elements.log.children)
      .map((line) => line.textContent)
      .join('\r\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `punk-badge-flasher-${new Date().toISOString().replace(/[:.]/g, '-')}.log.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function initialiseSupportState() {
    if (!window.isSecureContext) {
      webSerialSupported = false;
      elements.supportBanner.className = 'support-banner error';
      elements.supportBanner.textContent =
        'Web Serial requires HTTPS or localhost. GitHub Pages works; opening index.html directly from disk does not.';
      return;
    }

    if (!('serial' in navigator)) {
      webSerialSupported = false;
      elements.supportBanner.className = 'support-banner error';
      elements.supportBanner.textContent =
        'Web Serial is unavailable in this browser. Use a current desktop version of Chrome or Edge.';
      return;
    }

    webSerialSupported = true;
    elements.supportBanner.className = 'support-banner ok';
    elements.supportBanner.textContent =
      'Web Serial is ready. Firmware is downloaded from this site, but programming and serial traffic stay inside the browser.';
  }

  async function restoreAuthorisedPort() {
    if (!webSerialSupported || typeof navigator.serial.getPorts !== 'function') {
      return;
    }

    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length === 1) {
        selectedPort = ports[0];
        log('Restored the previously authorised serial adapter.', 'success');
        setStatus('Previously authorised serial adapter restored', 'good');
      } else if (ports.length > 1) {
        log(`${ports.length} serial ports are already authorised; choose the required adapter.`);
      }
    } catch (error) {
      log(`Could not inspect previously authorised ports: ${error.message}`, 'warn');
    }
    updateActionState();
  }

  elements.selectedImage.addEventListener('error', () => {
    elements.selectedImage.hidden = true;
    elements.selectedImageFallback.hidden = false;
  });
  elements.changeBadge.addEventListener('click', () => {
    document.querySelector('#catalogue-title').scrollIntoView({ behavior: 'smooth' });
  });
  elements.chooseCustomHex.addEventListener('click', openCustomHexPicker);
  elements.customTarget.addEventListener('change', updateCustomTarget);
  elements.customHexInput.addEventListener('change', () => {
    const [file] = elements.customHexInput.files || [];
    if (file) {
      loadCustomHexFile(file);
    }
  });
  elements.choosePort.addEventListener('click', choosePort);
  elements.identify.addEventListener('click', runIdentify);
  elements.flash.addEventListener('click', runFlash);
  elements.cancel.addEventListener('click', () => {
    cancelRequested = true;
    elements.cancel.disabled = true;
    log('Cancellation requested; the current UPDI transaction will finish first.', 'warn');
  });
  elements.clearLog.addEventListener('click', () => {
    elements.log.replaceChildren();
    log('Log cleared.');
  });
  elements.downloadLog.addEventListener('click', downloadLog);

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (event.target === selectedPort) {
        selectedPort = null;
        log('The selected serial adapter was disconnected.', 'warn');
        setStatus('Serial adapter disconnected', 'bad');
        updateActionState();
      }
    });
  }

  setProgress(0, 'Idle');
  setStatus('Waiting for badge and serial port', 'neutral');
  initialiseSupportState();
  updateActionState();
  log(`Punk Security badge flasher initialised with ${Object.keys(DEVICE_PROFILES).length} target profiles.`);
  loadCatalogue();
  restoreAuthorisedPort();
})();
