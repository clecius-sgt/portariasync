(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PortariaSyncResidentPhone = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function digits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function withoutCountryCode(value) {
    const raw = digits(value);
    return raw.startsWith('55') && (raw.length === 12 || raw.length === 13) ? raw.slice(2) : raw;
  }

  function formatLocalNumber(value) {
    const raw = digits(value).slice(0, 9);
    if (raw.length <= 4) return raw;
    const split = raw.length > 8 ? 5 : 4;
    return raw.slice(0, split) + '-' + raw.slice(split);
  }

  function split(value) {
    const raw = withoutCountryCode(value);
    if (raw.length === 10 || raw.length === 11) {
      return { ddd: raw.slice(0, 2), number: raw.slice(2), complete: true, raw };
    }
    if (raw.length === 8 || raw.length === 9) {
      return { ddd: '', number: raw, complete: false, missingDdd: true, raw };
    }
    return { ddd: '', number: raw, complete: false, missingDdd: false, raw };
  }

  function format(value, options = {}) {
    const parts = split(value);
    if (!parts.raw) return options.emptyLabel || '';
    if (parts.complete) return '(' + parts.ddd + ') ' + formatLocalNumber(parts.number);
    if (parts.missingDdd) return (options.missingDddLabel || 'DDD ausente') + ' · ' + formatLocalNumber(parts.number);
    return parts.raw;
  }

  function combine(ddd, number) {
    const area = digits(ddd).slice(0, 2);
    const local = digits(number).slice(0, 9);
    if (!area && !local) return '';
    return area + local;
  }

  return { digits, withoutCountryCode, formatLocalNumber, split, format, combine };
});
