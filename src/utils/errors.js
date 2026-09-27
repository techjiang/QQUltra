export class QQUltraError extends Error {
  constructor(message, { code = 'E_QQULTRA', cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigError extends QQUltraError {
  constructor(message, opts) {
    super(message, { code: 'E_CONFIG', ...opts });
  }
}

export class AdapterError extends QQUltraError {
  constructor(message, opts) {
    super(message, { code: 'E_ADAPTER', ...opts });
  }
}

export class StorageError extends QQUltraError {
  constructor(message, opts) {
    super(message, { code: 'E_STORAGE', ...opts });
  }
}
