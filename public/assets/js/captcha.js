/*
 * Privacy-friendly proof-of-work CAPTCHA client. Fetches a signed challenge
 * from our own API and finds the number n where SHA-256(salt + n) equals the
 * challenge, using the browser's built-in Web Crypto. No third parties, no
 * cookies, no tracking, no image puzzles.
 */
(function () {
  'use strict';

  var encoder = new TextEncoder();
  var BATCH = 500;

  function hex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }

  function findNumber(ch) {
    var start = 0;
    function nextBatch() {
      if (start > ch.maxNumber) return Promise.reject(new Error('Verification could not be completed'));
      var base = start;
      var end = Math.min(start + BATCH, ch.maxNumber + 1);
      var jobs = [];
      for (var n = base; n < end; n++) jobs.push(crypto.subtle.digest('SHA-256', encoder.encode(ch.salt + n)).then(hex));
      start = end;
      return Promise.all(jobs).then(function (hashes) {
        var i = hashes.indexOf(ch.challenge);
        return i >= 0 ? base + i : nextBatch();
      });
    }
    return nextBatch();
  }

  window.BcbCaptcha = {
    /** Resolves to a base64 solution to send with the protected request. */
    solve: function (purpose) {
      if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('Your browser does not support secure verification. Please use an up-to-date browser over HTTPS.'));
      return fetch('/api/captcha/challenge?purpose=' + encodeURIComponent(purpose), { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('Could not start human verification (' + res.status + ')');
          return res.json();
        })
        .then(function (ch) {
          return findNumber(ch).then(function (number) {
            return btoa(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number: number, salt: ch.salt, signature: ch.signature }));
          });
        });
    },
  };
})();
