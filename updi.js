'use strict';

const UPDI = Object.freeze({
  SYNCH: 0x55,
  ACK: 0x40,

  LDS: 0x00,
  STS: 0x40,
  LD: 0x20,
  ST: 0x60,
  LDCS: 0x80,
  STCS: 0xC0,
  REPEAT: 0xA0,
  KEY: 0xE0,

  PTR: 0x00,
  PTR_INC: 0x04,
  PTR_ADDRESS: 0x08,
  ADDRESS_16: 0x04,
  DATA_8: 0x00,
  DATA_16: 0x01,

  STATUSA: 0x00,
  CTRLA: 0x02,
  CTRLB: 0x03,
  ASI_KEY_STATUS: 0x07,
  ASI_RESET_REQ: 0x08,
  ASI_CTRLA: 0x09,
  ASI_SYS_STATUS: 0x0B,

  CTRLA_IBDLY: 1 << 7,
  CTRLA_RSD: 1 << 3,
  CTRLB_CCDETDIS: 1 << 3,
  CTRLB_UPDIDIS: 1 << 2,

  KEY_STATUS_CHIPERASE: 1 << 3,
  KEY_STATUS_NVMPROG: 1 << 4,
  SYS_STATUS_LOCK: 1 << 0,
  SYS_STATUS_NVMPROG: 1 << 3,
  RESET_SIGNATURE: 0x59,

  NVM_KEY: 'NVMProg ',
  ERASE_KEY: 'NVMErase',

  FLASH_BASE: 0x8000,
  SIGROW_BASE: 0x1100,
  FUSES_BASE: 0x1280,
  NVMCTRL_BASE: 0x1000,

  NVM_CTRLA: 0x00,
  NVM_STATUS: 0x02,
  NVM_DATAL: 0x06,
  NVM_DATAH: 0x07,
  NVM_ADDRL: 0x08,
  NVM_ADDRH: 0x09,

  NVM_CMD_WRITE_PAGE: 0x01,
  NVM_CMD_PAGE_BUFFER_CLEAR: 0x04,
  NVM_CMD_CHIP_ERASE: 0x05,
  NVM_CMD_WRITE_FUSE: 0x07,

  NVM_STATUS_WRITE_ERROR: 1 << 2,
  NVM_STATUS_EEPROM_BUSY: 1 << 1,
  NVM_STATUS_FLASH_BUSY: 1 << 0,

});

const DEVICE_PROFILES = Object.freeze({
  attiny402: Object.freeze({
    key: 'attiny402',
    label: 'ATtiny402',
    signature: Object.freeze([0x1E, 0x92, 0x27]),
    flashSize: 0x1000,
    flashPageSize: 0x40,
  }),
  attiny412: Object.freeze({
    key: 'attiny412',
    label: 'ATtiny412',
    signature: Object.freeze([0x1E, 0x92, 0x23]),
    flashSize: 0x1000,
    flashPageSize: 0x40,
  }),
  attiny814: Object.freeze({
    key: 'attiny814',
    label: 'ATtiny814',
    signature: Object.freeze([0x1E, 0x93, 0x22]),
    flashSize: 0x2000,
    flashPageSize: 0x40,
  }),
});

function getDeviceProfile(target = 'attiny814') {
  if (target && typeof target === 'object' && target.key) {
    target = target.key;
  }

  const key = String(target || '').trim().toLowerCase();
  const profile = DEVICE_PROFILES[key];
  if (!profile) {
    throw new Error(
      `Unsupported target ${target || '(blank)'}. Choose ATtiny402, ATtiny412 or ATtiny814.`
    );
  }
  return profile;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexByte(value) {
  return `0x${Number(value).toString(16).padStart(2, '0').toUpperCase()}`;
}

function hexWord(value) {
  return `0x${Number(value).toString(16).padStart(4, '0').toUpperCase()}`;
}

function bytesToHex(bytes, separator = ' ') {
  return Array.from(bytes, hexByte).join(separator);
}

function parseByteValue(text) {
  const valueText = String(text).trim();
  let value;

  if (/^0b[01]+$/i.test(valueText)) {
    value = Number.parseInt(valueText.slice(2), 2);
  } else if (/^0x[0-9a-f]+$/i.test(valueText)) {
    value = Number.parseInt(valueText.slice(2), 16);
  } else if (/^[0-9]+$/.test(valueText)) {
    value = Number.parseInt(valueText, 10);
  } else {
    throw new Error(`Invalid byte value: ${valueText}`);
  }

  if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
    throw new Error(`Byte value outside 0..255: ${valueText}`);
  }

  return value;
}

class UpdiError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UpdiError';
    if (cause) {
      this.cause = cause;
    }
  }
}

class IntelHexImage {
  constructor(bytes, present, dataByteCount, firstAddress, lastAddress, device) {
    this.bytes = bytes;
    this.present = present;
    this.dataByteCount = dataByteCount;
    this.firstAddress = firstAddress;
    this.lastAddress = lastAddress;
    this.device = device;
  }

  static parse(text, target = 'attiny814') {
    const device = getDeviceProfile(target);
    const flash = new Uint8Array(device.flashSize);
    flash.fill(0xFF);
    const present = new Uint8Array(device.flashSize);

    const lines = String(text).replace(/\r/g, '').split('\n');
    let upperAddress = 0;
    let eofSeen = false;
    let firstAddress = Number.POSITIVE_INFINITY;
    let lastAddress = -1;
    let dataByteCount = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex].trim();
      if (!line) {
        continue;
      }
      if (!line.startsWith(':')) {
        throw new Error(`HEX line ${lineIndex + 1} does not start with ':'`);
      }
      if ((line.length - 1) % 2 !== 0) {
        throw new Error(`HEX line ${lineIndex + 1} has an odd number of digits`);
      }

      const record = [];
      for (let i = 1; i < line.length; i += 2) {
        const value = Number.parseInt(line.slice(i, i + 2), 16);
        if (Number.isNaN(value)) {
          throw new Error(`HEX line ${lineIndex + 1} contains invalid hexadecimal data`);
        }
        record.push(value);
      }

      if (record.length < 5) {
        throw new Error(`HEX line ${lineIndex + 1} is too short`);
      }

      const byteCount = record[0];
      if (record.length !== byteCount + 5) {
        throw new Error(`HEX line ${lineIndex + 1} has an invalid byte count`);
      }

      const checksum = record.reduce((sum, value) => (sum + value) & 0xFF, 0);
      if (checksum !== 0) {
        throw new Error(`HEX checksum failed on line ${lineIndex + 1}`);
      }

      const address = (record[1] << 8) | record[2];
      const recordType = record[3];
      const data = record.slice(4, 4 + byteCount);

      if (eofSeen) {
        throw new Error(`HEX data appears after EOF on line ${lineIndex + 1}`);
      }

      switch (recordType) {
        case 0x00: {
          for (let i = 0; i < data.length; i += 1) {
            const absoluteAddress = upperAddress + address + i;
            let flashOffset;

            if (absoluteAddress >= 0 && absoluteAddress < device.flashSize) {
              flashOffset = absoluteAddress;
            } else if (
              absoluteAddress >= UPDI.FLASH_BASE &&
              absoluteAddress < UPDI.FLASH_BASE + device.flashSize
            ) {
              flashOffset = absoluteAddress - UPDI.FLASH_BASE;
            } else {
              throw new Error(
                `HEX data at ${hexWord(absoluteAddress)} is outside ${device.label} flash`
              );
            }

            if (!present[flashOffset]) {
              dataByteCount += 1;
            }
            flash[flashOffset] = data[i];
            present[flashOffset] = 1;
            firstAddress = Math.min(firstAddress, flashOffset);
            lastAddress = Math.max(lastAddress, flashOffset);
          }
          break;
        }

        case 0x01:
          if (byteCount !== 0) {
            throw new Error(`HEX EOF record on line ${lineIndex + 1} contains data`);
          }
          eofSeen = true;
          break;

        case 0x02:
          if (byteCount !== 2) {
            throw new Error(`Invalid extended segment address on line ${lineIndex + 1}`);
          }
          upperAddress = ((data[0] << 8) | data[1]) << 4;
          break;

        case 0x04:
          if (byteCount !== 2) {
            throw new Error(`Invalid extended linear address on line ${lineIndex + 1}`);
          }
          upperAddress = ((data[0] << 8) | data[1]) * 0x10000;
          break;

        case 0x03:
        case 0x05:
          // Start-address metadata is not needed when programming flash.
          break;

        default:
          throw new Error(
            `Unsupported Intel HEX record type ${hexByte(recordType)} on line ${lineIndex + 1}`
          );
      }
    }

    if (!eofSeen) {
      throw new Error('HEX file has no EOF record');
    }
    if (lastAddress < 0) {
      throw new Error('HEX file contains no flash data');
    }

    return new IntelHexImage(
      flash,
      present,
      dataByteCount,
      firstAddress,
      lastAddress,
      device
    );
  }

  get spanBytes() {
    return this.lastAddress + 1;
  }

  get pageCount() {
    return Math.ceil(this.spanBytes / this.device.flashPageSize);
  }

  get programmedPageCount() {
    let count = 0;
    for (let page = 0; page < this.pageCount; page += 1) {
      const start = page * this.device.flashPageSize;
      const end = start + this.device.flashPageSize;
      let nonBlank = false;
      for (let i = start; i < end; i += 1) {
        if (this.bytes[i] !== 0xFF) {
          nonBlank = true;
          break;
        }
      }
      if (nonBlank) {
        count += 1;
      }
    }
    return count;
  }

  pagesToProgram() {
    const pages = [];
    for (let page = 0; page < this.pageCount; page += 1) {
      const offset = page * this.device.flashPageSize;
      const data = this.bytes.slice(offset, offset + this.device.flashPageSize);
      if (data.some((value) => value !== 0xFF)) {
        pages.push({ offset, data });
      }
    }
    return pages;
  }
}

class WebSerialTransport {
  constructor(port, log = () => {}) {
    this.port = port;
    this.log = log;
    this.reader = null;
    this.readerLoopPromise = null;
    this.rx = [];
    this.waiters = [];
    this.readError = null;
    this.closing = false;
    this.isOpen = false;
    this.baudRate = 0;
  }

  async open({ baudRate, parity = 'even', stopBits = 2, assertSignals = true }) {
    if (this.isOpen) {
      await this.close();
    }

    this.rx.length = 0;
    this.readError = null;
    this.closing = false;

    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits,
      parity,
      bufferSize: 4096,
      flowControl: 'none',
    });

    this.isOpen = true;
    this.baudRate = baudRate;

    if (typeof this.port.setSignals === 'function') {
      try {
        await this.port.setSignals({
          dataTerminalReady: Boolean(assertSignals),
          requestToSend: Boolean(assertSignals),
          break: false,
        });
      } catch (error) {
        this.log(`Modem-control signals were not changed: ${error.message}`);
      }
    }

    this.reader = this.port.readable.getReader();
    this.readerLoopPromise = this.#readerLoop();
  }

  async #readerLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value && value.length) {
          for (const byte of value) {
            this.rx.push(byte);
          }
          this.#wakeWaiters();
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.readError = error;
        this.#wakeWaiters();
      }
    }
  }

  #wakeWaiters() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  async #waitForData(timeoutMs) {
    if (this.readError) {
      throw this.readError;
    }

    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new UpdiError(`Serial read timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });

    if (this.readError) {
      throw this.readError;
    }
  }

  async readExact(count, timeoutMs = 1000) {
    const startedAt = performance.now();

    while (this.rx.length < count) {
      const elapsed = performance.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        throw new UpdiError(
          `Serial read timed out waiting for ${count} bytes; received ${this.rx.length}`
        );
      }
      await this.#waitForData(remaining);
    }

    return Uint8Array.from(this.rx.splice(0, count));
  }

  async write(bytes) {
    if (!this.isOpen || !this.port.writable) {
      throw new UpdiError('Serial port is not open for writing');
    }

    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  async sendWithEcho(bytes, timeoutMs = 1000) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    await this.write(data);
    const echo = await this.readExact(data.length, timeoutMs);

    for (let i = 0; i < data.length; i += 1) {
      if (echo[i] !== data[i]) {
        throw new UpdiError(
          `SerialUPDI echo mismatch at byte ${i}: sent ${hexByte(data[i])}, ` +
          `received ${hexByte(echo[i])}`
        );
      }
    }
  }

  async setBreak(asserted) {
    if (typeof this.port.setSignals !== 'function') {
      throw new UpdiError('This browser/adapter does not expose the serial break signal');
    }
    await this.port.setSignals({ break: Boolean(asserted) });
  }

  discardInput() {
    this.rx.length = 0;
  }

  async close() {
    if (!this.isOpen) {
      return;
    }

    this.closing = true;
    this.#wakeWaiters();

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (_) {
        // Ignore cancellation errors while closing.
      }
    }

    if (this.readerLoopPromise) {
      try {
        await this.readerLoopPromise;
      } catch (_) {
        // The read loop reports operational errors through readError.
      }
    }

    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch (_) {
        // Lock may already have been released by the browser.
      }
    }

    this.reader = null;
    this.readerLoopPromise = null;
    this.rx.length = 0;

    try {
      await this.port.close();
    } finally {
      this.isOpen = false;
      this.baudRate = 0;
    }
  }
}

class UpdiProgrammer {
  constructor(port, options = {}) {
    this.port = port;
    this.options = {
      baudRate: 460800,
      writeDelayMs: 1,
      verify: true,
      assertSignals: true,
      log: () => {},
      progress: () => {},
      isCancelled: () => false,
      ...options,
    };
    this.device = getDeviceProfile(this.options.device || this.options.target || 'attiny814');
    this.transport = new WebSerialTransport(port, this.options.log);
    this.inProgrammingMode = false;
  }

  log(message) {
    this.options.log(message);
  }

  setProgress(value, label) {
    this.options.progress(Math.max(0, Math.min(100, value)), label);
  }

  checkCancelled() {
    if (this.options.isCancelled()) {
      throw new UpdiError('Operation cancelled');
    }
  }

  async sendDoubleBreak() {
    this.log('Sending UPDI double break at 300 baud…');

    try {
      await this.transport.open({
        baudRate: 300,
        parity: 'none',
        stopBits: 1,
        assertSignals: this.options.assertSignals,
      });
      await this.transport.write(Uint8Array.from([0x00, 0x00]));
      // At 300 baud, two zero characters take long enough to be seen as breaks.
      await sleep(120);
      await this.transport.close();
      await sleep(30);
      return;
    } catch (primaryError) {
      try {
        await this.transport.close();
      } catch (_) {
        // Continue to the hardware-break fallback.
      }

      this.log(`300-baud break failed (${primaryError.message}); trying BREAK control…`);
      try {
        await this.transport.open({
          baudRate: 57600,
          parity: 'none',
          stopBits: 1,
          assertSignals: this.options.assertSignals,
        });
        for (let i = 0; i < 2; i += 1) {
          await this.transport.setBreak(true);
          await sleep(30);
          await this.transport.setBreak(false);
          await sleep(10);
        }
        await this.transport.close();
        await sleep(30);
      } catch (fallbackError) {
        try {
          await this.transport.close();
        } catch (_) {
          // Ignore close failure; report both useful errors below.
        }
        throw new UpdiError(
          `Could not send UPDI break. 300-baud method: ${primaryError.message}; ` +
          `BREAK-control method: ${fallbackError.message}`,
          fallbackError
        );
      }
    }
  }

  async connect() {
    const requestedBaud = Number(this.options.baudRate);
    if (![57600, 115200, 230400, 460800].includes(requestedBaud)) {
      throw new UpdiError(`Unsupported baud rate: ${requestedBaud}`);
    }

    await this.sendDoubleBreak();

    const bootstrapBaud = Math.min(requestedBaud, 230400);
    this.log(`Opening SerialUPDI at ${bootstrapBaud} baud, 8-E-2…`);
    await this.transport.open({
      baudRate: bootstrapBaud,
      parity: 'even',
      stopBits: 2,
      assertSignals: this.options.assertSignals,
    });
    await this.initializeLink();

    if (requestedBaud > 230400) {
      this.log('Switching the target UPDI clock to maximum for turbo mode…');
      // supported tinyAVR 0/1-series ASI_CTRLA.UPDICLKSEL = 0 selects the maximum clock.
      await this.stcs(UPDI.ASI_CTRLA, 0x00);
      await sleep(5);
      await this.transport.close();
      await sleep(20);

      this.log(`Reopening SerialUPDI at ${requestedBaud} baud, 8-E-2…`);
      try {
        await this.transport.open({
          baudRate: requestedBaud,
          parity: 'even',
          stopBits: 2,
          assertSignals: this.options.assertSignals,
        });
        await this.initializeLink();
      } catch (turboError) {
        try {
          await this.transport.close();
        } catch (_) {
          // Continue with the safe-speed fallback.
        }

        this.log(
          `Turbo link failed (${turboError.message}); falling back to ${bootstrapBaud} baud…`
        );
        await sleep(20);
        await this.transport.open({
          baudRate: bootstrapBaud,
          parity: 'even',
          stopBits: 2,
          assertSignals: this.options.assertSignals,
        });
        await this.initializeLink();
      }
    }
  }

  async initializeLink() {
    // Disable collision detection and use the inter-byte delay required by UPDI.
    await this.stcs(UPDI.CTRLB, UPDI.CTRLB_CCDETDIS);
    await this.stcs(UPDI.CTRLA, UPDI.CTRLA_IBDLY);
    const status = await this.ldcs(UPDI.STATUSA);
    if (status === 0x00 || status === 0xFF) {
      throw new UpdiError(`UPDI initialisation returned invalid STATUSA ${hexByte(status)}`);
    }
    this.log(`UPDI link ready (STATUSA ${hexByte(status)}).`);
  }

  async close() {
    await this.transport.close();
    this.inProgrammingMode = false;
  }

  async stcs(register, value) {
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.STCS | (register & 0x0F),
      value & 0xFF,
    ]);
  }

  async ldcs(register) {
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.LDCS | (register & 0x0F),
    ]);
    return (await this.transport.readExact(1))[0];
  }

  async expectAck(context) {
    const value = (await this.transport.readExact(1))[0];
    if (value !== UPDI.ACK) {
      throw new UpdiError(`${context}: expected ACK ${hexByte(UPDI.ACK)}, got ${hexByte(value)}`);
    }
  }

  async lds8(address) {
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.LDS | UPDI.ADDRESS_16 | UPDI.DATA_8,
      address & 0xFF,
      (address >> 8) & 0xFF,
    ]);
    return (await this.transport.readExact(1))[0];
  }

  async sts8(address, value) {
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.STS | UPDI.ADDRESS_16 | UPDI.DATA_8,
      address & 0xFF,
      (address >> 8) & 0xFF,
    ]);
    await this.expectAck(`STS address ${hexWord(address)}`);
    await this.transport.sendWithEcho([value & 0xFF]);
    await this.expectAck(`STS data ${hexWord(address)}`);
  }

  async setPointer(address) {
    // ST PTR_ADDRESS carries the 16-bit pointer value in the same frame and
    // produces one ACK after the complete command.
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.ST | UPDI.PTR_ADDRESS | UPDI.DATA_16,
      address & 0xFF,
      (address >> 8) & 0xFF,
    ]);
    await this.expectAck('Set pointer address');
  }

  async repeat(count) {
    if (!Number.isInteger(count) || count < 1 || count > 256) {
      throw new UpdiError(`UPDI repeat count must be 1..256, got ${count}`);
    }
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.REPEAT | UPDI.DATA_8,
      (count - 1) & 0xFF,
    ]);
  }

  async readBytes(address, length) {
    if (!Number.isInteger(length) || length < 1 || length > 256) {
      throw new UpdiError(`Read length must be 1..256, got ${length}`);
    }
    await this.setPointer(address);
    if (length > 1) {
      await this.repeat(length);
    }
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.LD | UPDI.PTR_INC | UPDI.DATA_8,
    ]);
    return this.transport.readExact(length, 2000);
  }

  async readWords(address, byteLength) {
    if (byteLength < 2 || byteLength > 512 || (byteLength & 1)) {
      throw new UpdiError(`Word read length must be even and between 2 and 512`);
    }
    const wordCount = byteLength / 2;
    await this.setPointer(address);
    if (wordCount > 1) {
      await this.repeat(wordCount);
    }
    await this.transport.sendWithEcho([
      UPDI.SYNCH,
      UPDI.LD | UPDI.PTR_INC | UPDI.DATA_16,
    ]);
    return this.transport.readExact(byteLength, 3000);
  }

  async writeWords(address, data) {
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    if (!bytes.length || (bytes.length & 1) || bytes.length > 512) {
      throw new UpdiError('Word write data must be a non-empty even number of bytes, at most 512');
    }

    await this.setPointer(address);
    const wordCount = bytes.length / 2;
    if (wordCount > 1) {
      await this.repeat(wordCount);
    }

    // Suppress target ACKs during the block transfer, exactly as SerialUPDI does.
    await this.stcs(UPDI.CTRLA, UPDI.CTRLA_IBDLY | UPDI.CTRLA_RSD);
    try {
      await this.transport.sendWithEcho([
        UPDI.SYNCH,
        UPDI.ST | UPDI.PTR_INC | UPDI.DATA_16,
      ]);
      await this.transport.sendWithEcho(bytes, 4000);
    } finally {
      await this.stcs(UPDI.CTRLA, UPDI.CTRLA_IBDLY);
    }
  }

  async sendKey(keyText) {
    const keyBytes = Array.from(new TextEncoder().encode(keyText)).reverse();
    if (keyBytes.length !== 8) {
      throw new UpdiError(`UPDI key must contain exactly 8 bytes: ${keyText}`);
    }
    await this.transport.sendWithEcho([UPDI.SYNCH, UPDI.KEY]);
    await this.transport.sendWithEcho(keyBytes);
  }

  async resetTarget(assertReset) {
    await this.stcs(
      UPDI.ASI_RESET_REQ,
      assertReset ? UPDI.RESET_SIGNATURE : 0x00
    );
  }

  async releaseTarget() {
    if (!this.transport.isOpen) {
      return;
    }

    // Match the normal SerialUPDI exit sequence: reset into the application,
    // then disable UPDI while leaving collision detection disabled.
    await this.resetTarget(true);
    await sleep(2);
    await this.resetTarget(false);
    await sleep(5);
    await this.stcs(
      UPDI.CTRLB,
      UPDI.CTRLB_CCDETDIS | UPDI.CTRLB_UPDIDIS
    );
    this.inProgrammingMode = false;
    await sleep(20);
  }

  async waitForSystemStatus(predicate, description, timeoutMs = 2000) {
    const startedAt = performance.now();
    let status = 0;
    while (performance.now() - startedAt < timeoutMs) {
      status = await this.ldcs(UPDI.ASI_SYS_STATUS);
      if (predicate(status)) {
        return status;
      }
      await sleep(5);
    }
    throw new UpdiError(`${description} timed out; ASI_SYS_STATUS=${hexByte(status)}`);
  }

  async enterProgrammingMode() {
    let systemStatus = await this.ldcs(UPDI.ASI_SYS_STATUS);
    if (systemStatus & UPDI.SYS_STATUS_NVMPROG) {
      this.inProgrammingMode = true;
      return;
    }

    await this.sendKey(UPDI.NVM_KEY);
    const keyStatus = await this.ldcs(UPDI.ASI_KEY_STATUS);
    if (!(keyStatus & UPDI.KEY_STATUS_NVMPROG)) {
      throw new UpdiError(
        `NVM programming key was not accepted (ASI_KEY_STATUS=${hexByte(keyStatus)})`
      );
    }

    await this.resetTarget(true);
    await sleep(2);
    await this.resetTarget(false);

    systemStatus = await this.waitForSystemStatus(
      (value) =>
        !(value & UPDI.SYS_STATUS_LOCK) &&
        Boolean(value & UPDI.SYS_STATUS_NVMPROG),
      'Waiting for NVM programming mode'
    );

    if (!(systemStatus & UPDI.SYS_STATUS_NVMPROG)) {
      throw new UpdiError(
        `Target did not enter NVM programming mode (ASI_SYS_STATUS=${hexByte(systemStatus)})`
      );
    }

    this.inProgrammingMode = true;
  }

  async unlockWithChipEraseKey() {
    this.log('Target is locked; requesting UPDI chip-erase unlock…');
    await this.sendKey(UPDI.ERASE_KEY);
    const keyStatus = await this.ldcs(UPDI.ASI_KEY_STATUS);
    if (!(keyStatus & UPDI.KEY_STATUS_CHIPERASE)) {
      throw new UpdiError(
        `Chip-erase key was not accepted (ASI_KEY_STATUS=${hexByte(keyStatus)})`
      );
    }

    await this.resetTarget(true);
    await sleep(2);
    await this.resetTarget(false);
    await this.waitForSystemStatus(
      (value) => !(value & UPDI.SYS_STATUS_LOCK),
      'Waiting for chip-erase unlock',
      5000
    );
    await this.enterProgrammingMode();
  }

  async ensureProgrammingMode() {
    try {
      await this.enterProgrammingMode();
    } catch (error) {
      let status;
      try {
        status = await this.ldcs(UPDI.ASI_SYS_STATUS);
      } catch (_) {
        throw error;
      }

      if (status & UPDI.SYS_STATUS_LOCK) {
        await this.unlockWithChipEraseKey();
      } else {
        throw error;
      }
    }
  }

  async readDeviceId() {
    return this.readBytes(UPDI.SIGROW_BASE, 3);
  }

  validateDeviceId(id) {
    const expected = this.device.signature;
    const matches = id.length === expected.length && id.every((value, i) => value === expected[i]);
    if (!matches) {
      throw new UpdiError(
        `Wrong target. Expected ${this.device.label} ID ${bytesToHex(expected)}, got ${bytesToHex(id)}`
      );
    }
  }

  async nvmWaitReady(timeoutMs = 10000) {
    const startedAt = performance.now();
    let status = 0;

    while (performance.now() - startedAt < timeoutMs) {
      status = await this.lds8(UPDI.NVMCTRL_BASE + UPDI.NVM_STATUS);
      if (status & UPDI.NVM_STATUS_WRITE_ERROR) {
        throw new UpdiError(`NVMCTRL reports a write error (${hexByte(status)})`);
      }
      if (!(status & (UPDI.NVM_STATUS_EEPROM_BUSY | UPDI.NVM_STATUS_FLASH_BUSY))) {
        return;
      }
      await sleep(2);
    }

    throw new UpdiError(`NVMCTRL remained busy (${hexByte(status)})`);
  }

  async nvmCommand(command) {
    await this.sts8(UPDI.NVMCTRL_BASE + UPDI.NVM_CTRLA, command);
  }

  async chipErase() {
    this.log('Erasing target flash…');
    await this.nvmWaitReady();
    await this.nvmCommand(UPDI.NVM_CMD_CHIP_ERASE);
    if (this.options.writeDelayMs > 0) {
      await sleep(this.options.writeDelayMs);
    }
    await this.nvmWaitReady(10000);
  }

  async writeFlashPage(offset, data) {
    if (offset % this.device.flashPageSize !== 0) {
      throw new UpdiError(`Flash page offset ${hexWord(offset)} is not page aligned`);
    }
    if (data.length !== this.device.flashPageSize) {
      throw new UpdiError(`Flash page must contain ${this.device.flashPageSize} bytes`);
    }

    await this.nvmWaitReady();
    await this.nvmCommand(UPDI.NVM_CMD_PAGE_BUFFER_CLEAR);
    await this.nvmWaitReady();
    await this.writeWords(UPDI.FLASH_BASE + offset, data);
    await this.nvmCommand(UPDI.NVM_CMD_WRITE_PAGE);
    if (this.options.writeDelayMs > 0) {
      await sleep(this.options.writeDelayMs);
    }
    await this.nvmWaitReady();
  }

  async writeFuse(index, value) {
    if (!Number.isInteger(index) || index < 0 || index > 10) {
      throw new UpdiError(`Unsupported fuse index: ${index}`);
    }

    const fuseAddress = UPDI.FUSES_BASE + index;
    await this.nvmWaitReady();
    await this.sts8(UPDI.NVMCTRL_BASE + UPDI.NVM_ADDRL, fuseAddress & 0xFF);
    await this.sts8(UPDI.NVMCTRL_BASE + UPDI.NVM_ADDRH, (fuseAddress >> 8) & 0xFF);
    await this.sts8(UPDI.NVMCTRL_BASE + UPDI.NVM_DATAL, value & 0xFF);
    await this.nvmCommand(UPDI.NVM_CMD_WRITE_FUSE);
    if (this.options.writeDelayMs > 0) {
      await sleep(this.options.writeDelayMs);
    }
    await this.nvmWaitReady();
  }

  async readFuse(index) {
    return this.lds8(UPDI.FUSES_BASE + index);
  }

  async identify() {
    try {
      this.setProgress(5, 'Connecting');
      await this.connect();
      this.setProgress(35, 'Entering programming mode');
      await this.ensureProgrammingMode();
      this.setProgress(65, 'Reading device ID');
      const id = await this.readDeviceId();
      this.validateDeviceId(id);

      const fuses = {};
      for (const index of [0, 2, 6, 7, 8]) {
        fuses[index] = await this.readFuse(index);
      }

      this.setProgress(100, `${this.device.label} identified`);
      return { id, fuses };
    } finally {
      try {
        if (this.transport.isOpen) {
          await this.releaseTarget();
        }
      } catch (_) {
        // A failed identify may not have a working link to reset through.
      }
      await this.close();
    }
  }

  async program(image, fuses) {
    if (!(image instanceof IntelHexImage)) {
      throw new UpdiError('No valid Intel HEX image is loaded');
    }
    if (!image.device || image.device.key !== this.device.key) {
      throw new UpdiError(
        `Firmware was validated for ${image.device ? image.device.label : 'another target'}, ` +
        `but the programmer is configured for ${this.device.label}`
      );
    }

    const pages = image.pagesToProgram();
    let completedNormally = false;

    try {
      this.setProgress(1, 'Connecting');
      await this.connect();
      this.checkCancelled();

      this.setProgress(4, 'Entering programming mode');
      await this.ensureProgrammingMode();
      const id = await this.readDeviceId();
      this.validateDeviceId(id);
      this.log(`Detected ${this.device.label}, device ID ${bytesToHex(id)}.`);
      this.checkCancelled();

      this.setProgress(7, 'Erasing flash');
      await this.chipErase();
      this.checkCancelled();

      this.log(`Writing ${pages.length} non-blank flash page(s)…`);
      for (let i = 0; i < pages.length; i += 1) {
        this.checkCancelled();
        const page = pages[i];
        this.log(
          `Writing page ${i + 1}/${pages.length} at flash offset ${hexWord(page.offset)}…`
        );
        await this.writeFlashPage(page.offset, page.data);
        this.setProgress(10 + ((i + 1) / Math.max(1, pages.length)) * 55, 'Writing flash');
      }

      if (this.options.verify) {
        this.log(`Verifying ${image.pageCount} flash page(s)…`);
        for (let pageIndex = 0; pageIndex < image.pageCount; pageIndex += 1) {
          this.checkCancelled();
          const offset = pageIndex * this.device.flashPageSize;
          const expected = image.bytes.slice(offset, offset + this.device.flashPageSize);
          const actual = await this.readWords(
            UPDI.FLASH_BASE + offset,
            this.device.flashPageSize
          );

          for (let i = 0; i < this.device.flashPageSize; i += 1) {
            if (actual[i] !== expected[i]) {
              throw new UpdiError(
                `Flash verify failed at ${hexWord(offset + i)}: expected ` +
                `${hexByte(expected[i])}, read ${hexByte(actual[i])}`
              );
            }
          }

          this.setProgress(
            65 + ((pageIndex + 1) / Math.max(1, image.pageCount)) * 25,
            'Verifying flash'
          );
        }
        this.log('Flash verification passed.');
      } else {
        this.setProgress(90, 'Flash written');
      }

      const fuseEntries = Object.entries(fuses)
        .map(([index, value]) => [Number(index), Number(value)])
        .sort((a, b) => a[0] - b[0]);

      this.log('Writing fuses…');
      for (let i = 0; i < fuseEntries.length; i += 1) {
        this.checkCancelled();
        const [index, value] = fuseEntries[i];
        this.log(`Fuse ${index}: writing ${hexByte(value)}…`);
        await this.writeFuse(index, value);
        const readBack = await this.readFuse(index);
        if (readBack !== value) {
          throw new UpdiError(
            `Fuse ${index} verify failed: expected ${hexByte(value)}, read ${hexByte(readBack)}`
          );
        }
        this.setProgress(90 + ((i + 1) / fuseEntries.length) * 8, 'Writing fuses');
      }

      this.log('Resetting target into the new firmware…');
      await this.releaseTarget();
      completedNormally = true;
      this.setProgress(100, 'Flash complete');
      this.log('Programming and verification completed successfully.');
      return { id, pagesWritten: pages.length };
    } finally {
      if (!completedNormally && this.transport.isOpen) {
        try {
          await this.releaseTarget();
        } catch (_) {
          // Preserve the original programming error.
        }
      }
      await this.close();
    }
  }
}

window.WebUpdi = Object.freeze({
  UPDI,
  DEVICE_PROFILES,
  getDeviceProfile,
  IntelHexImage,
  WebSerialTransport,
  UpdiProgrammer,
  UpdiError,
  parseByteValue,
  hexByte,
  hexWord,
  bytesToHex,
  sleep,
});
