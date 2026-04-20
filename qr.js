/*!
 * Minimal QR code generator (version 1-10, L error correction).
 * Based on the reference algorithm from ISO/IEC 18004.
 * ~5KB uncompressed, no external runtime dependency.
 *
 * Public interface:
 *   HippoQR.render(targetEl, text, options?)
 *     targetEl : HTMLElement — container (contents replaced)
 *     text     : string      — payload (UTF-8, up to ~300 bytes at version 10)
 *     options  : {size?: number, pad?: number, fg?: string, bg?: string}
 *
 * Uses Byte mode + Reed-Solomon error correction (L = ~7% recoverable).
 */
(function () {
  "use strict";

  // ---------- Galois field arithmetic (GF(2^8), poly 0x11d) ----------
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenPoly(n) {
    var p = [1];
    for (var i = 0; i < n; i++) {
      p.push(0);
      for (var j = p.length - 1; j > 0; j--) p[j] = p[j - 1] ^ gfMul(p[j], EXP[i]);
      p[0] = gfMul(p[0], EXP[i]);
    }
    return p;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var out = data.slice();
    for (var i = 0; i < ecLen; i++) out.push(0);
    for (var k = 0; k < data.length; k++) {
      var c = out[k];
      if (c === 0) continue;
      for (var j = 0; j < gen.length; j++) out[k + j] ^= gfMul(gen[j], c);
    }
    return out.slice(data.length);
  }

  // ---------- Version data for L error correction, versions 1..10 ----------
  // [totalCodewords, dataCodewords, ecCodewordsPerBlock, numBlocks]
  var VERSIONS = [
    null,
    [26, 19, 7, 1],    // v1: 21x21
    [44, 34, 10, 1],   // v2: 25x25
    [70, 55, 15, 1],   // v3: 29x29
    [100, 80, 20, 1],  // v4: 33x33
    [134, 108, 26, 1], // v5: 37x37
    [172, 136, 18, 2], // v6: 41x41
    [196, 156, 20, 2], // v7: 45x45
    [242, 194, 24, 2], // v8: 49x49
    [292, 232, 30, 2], // v9: 53x53
    [346, 274, 18, 4], // v10: 57x57
  ];

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      // Byte mode: 4 bits mode + 8/16 bits length + 8 bits/char + padding
      var lenBits = (v < 10) ? 8 : 16;
      var totalBits = 4 + lenBits + byteLen * 8;
      var dataBits = VERSIONS[v][1] * 8;
      if (totalBits + 4 <= dataBits) return v;
    }
    return -1;
  }

  // ---------- Bit writer ----------
  function BitStream() { this.bits = []; }
  BitStream.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  };
  BitStream.prototype.toBytes = function (totalBytes) {
    while (this.bits.length % 8) this.bits.push(0);
    var bytes = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j];
      bytes.push(b);
    }
    var pad = [0xEC, 0x11], p = 0;
    while (bytes.length < totalBytes) bytes.push(pad[p++ % 2]);
    return bytes;
  };

  // ---------- Matrix construction ----------
  function QRMatrix(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.data = [];
    this.reserved = [];
    for (var i = 0; i < this.size; i++) {
      this.data.push(new Uint8Array(this.size));
      this.reserved.push(new Uint8Array(this.size));
    }
  }
  QRMatrix.prototype.setModule = function (r, c, v, reserved) {
    this.data[r][c] = v ? 1 : 0;
    if (reserved) this.reserved[r][c] = 1;
  };
  QRMatrix.prototype.placeFinder = function (r, c) {
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= this.size || cc >= this.size) continue;
        var on;
        if (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) on = 1;
        else if (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) on = 1;
        else if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) on = 1;
        else on = 0;
        this.setModule(rr, cc, on, true);
      }
    }
  };
  QRMatrix.prototype.placeTimingAndFixed = function () {
    for (var i = 8; i < this.size - 8; i++) {
      this.setModule(6, i, i % 2 === 0 ? 1 : 0, true);
      this.setModule(i, 6, i % 2 === 0 ? 1 : 0, true);
    }
    // Dark module
    this.setModule(this.size - 8, 8, 1, true);
    // Reserve format info regions
    for (var j = 0; j < 9; j++) {
      if (j !== 6) this.reserved[8][j] = 1;
      if (j !== 6) this.reserved[j][8] = 1;
    }
    for (var k = 0; k < 8; k++) {
      this.reserved[8][this.size - 1 - k] = 1;
      this.reserved[this.size - 1 - k][8] = 1;
    }
  };
  QRMatrix.prototype.placeData = function (codewords) {
    var bits = [];
    for (var i = 0; i < codewords.length; i++)
      for (var j = 7; j >= 0; j--) bits.push((codewords[i] >> j) & 1);
    var bitIdx = 0, col = this.size - 1, up = true;
    while (col > 0) {
      if (col === 6) col--;
      for (var rowStep = 0; rowStep < this.size; rowStep++) {
        var row = up ? this.size - 1 - rowStep : rowStep;
        for (var colOfs = 0; colOfs < 2; colOfs++) {
          var c = col - colOfs;
          if (this.reserved[row][c]) continue;
          this.setModule(row, c, bitIdx < bits.length ? bits[bitIdx] : 0, false);
          bitIdx++;
        }
      }
      col -= 2; up = !up;
    }
  };
  QRMatrix.prototype.applyMask = function (maskIdx) {
    var fn = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r, _c) { return r % 2 === 0; },
      function (_r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
      function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
      function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
    ][maskIdx];
    for (var r = 0; r < this.size; r++)
      for (var c = 0; c < this.size; c++)
        if (!this.reserved[r][c] && fn(r, c)) this.data[r][c] ^= 1;
  };
  QRMatrix.prototype.placeFormat = function (maskIdx) {
    // Error correction L = 0b01
    var fmt = (0x01 << 3) | maskIdx;
    var rem = fmt;
    for (var i = 0; i < 10; i++) {
      rem <<= 1;
      if (rem & 0x400) rem ^= 0x537;
    }
    var bits = ((fmt << 10) | rem) ^ 0x5412;
    var self = this;
    function put(r, c, v) { self.data[r][c] = v; }
    for (var k = 0; k <= 5; k++) put(8, k, (bits >> k) & 1);
    put(8, 7, (bits >> 6) & 1);
    put(8, 8, (bits >> 7) & 1);
    put(7, 8, (bits >> 8) & 1);
    for (var j = 9; j < 15; j++) put(14 - j, 8, (bits >> j) & 1);
    for (var m = 0; m < 8; m++) put(this.size - 1 - m, 8, (bits >> m) & 1);
    for (var n = 0; n < 7; n++) put(8, this.size - 7 + n, (bits >> (n + 8)) & 1);
  };

  function buildMatrix(text) {
    // UTF-8 encode
    var utf8 = [];
    for (var i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      if (cp < 0x80) utf8.push(cp);
      else if (cp < 0x800) { utf8.push(0xC0 | (cp >> 6)); utf8.push(0x80 | (cp & 0x3F)); }
      else { utf8.push(0xE0 | (cp >> 12)); utf8.push(0x80 | ((cp >> 6) & 0x3F)); utf8.push(0x80 | (cp & 0x3F)); }
    }
    var v = pickVersion(utf8.length);
    if (v < 0) throw new Error("Payload too large for QR version <=10");
    var info = VERSIONS[v];
    var totalCW = info[0], dataCW = info[1], ecCW = info[2], blocks = info[3];

    var bs = new BitStream();
    bs.put(0x4, 4);                          // mode: byte
    bs.put(utf8.length, v < 10 ? 8 : 16);    // length
    for (var j = 0; j < utf8.length; j++) bs.put(utf8[j], 8);
    var bytes = bs.toBytes(dataCW);

    // Split into blocks, RS-encode each, interleave
    var blockSize = Math.floor(dataCW / blocks);
    var dataBlocks = [], ecBlocks = [];
    for (var b = 0; b < blocks; b++) {
      dataBlocks.push(bytes.slice(b * blockSize, (b + 1) * blockSize));
      ecBlocks.push(rsEncode(dataBlocks[b], ecCW));
    }
    var finalCW = [];
    for (var col = 0; col < blockSize; col++)
      for (var bb = 0; bb < blocks; bb++) finalCW.push(dataBlocks[bb][col]);
    for (var col2 = 0; col2 < ecCW; col2++)
      for (var bb2 = 0; bb2 < blocks; bb2++) finalCW.push(ecBlocks[bb2][col2]);

    var m = new QRMatrix(v);
    m.placeFinder(0, 0);
    m.placeFinder(0, m.size - 7);
    m.placeFinder(m.size - 7, 0);
    m.placeTimingAndFixed();
    m.placeData(finalCW);
    m.applyMask(0);
    m.placeFormat(0);
    return m;
  }

  // ---------- Public render ----------
  var HippoQR = {
    render: function (targetEl, text, options) {
      options = options || {};
      var size = options.size || 200;
      var pad = options.pad == null ? 16 : options.pad;
      var fg = options.fg || "#2a1c0a";
      var bg = options.bg || "#ffffff";

      while (targetEl.firstChild) targetEl.removeChild(targetEl.firstChild);

      var m;
      try { m = buildMatrix(text); }
      catch (e) {
        var err = document.createElement("div");
        err.textContent = "QR unavailable";
        err.style.color = "#8a7a5a";
        err.style.fontSize = "13px";
        targetEl.appendChild(err);
        return;
      }

      var n = m.size;
      var cell = Math.floor((size - 2 * pad) / n);
      if (cell < 1) cell = 1;
      var canvas = document.createElement("canvas");
      var px = cell * n + 2 * pad;
      canvas.width = px; canvas.height = px;
      canvas.style.width = px + "px";
      canvas.style.height = px + "px";
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = fg;
      for (var r = 0; r < n; r++)
        for (var c = 0; c < n; c++)
          if (m.data[r][c]) ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
      targetEl.appendChild(canvas);
    }
  };

  if (typeof window !== "undefined") window.HippoQR = HippoQR;
  if (typeof module !== "undefined" && module.exports) module.exports = HippoQR;
})();
