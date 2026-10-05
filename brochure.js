/* brochure.js — builds the bilingual (PT | EN) property brochure as a PDF, in the browser.
   Needs jsPDF (window.jspdf). Used by admin.html on every save.
   Layout mirrors the site: edge-to-edge tiles, beige / gold / ink, no decoration. */
(function (global) {
  const C = { bg: [240, 235, 226], deep: [233, 227, 216], ink: [28, 26, 23], mid: [138, 132, 121], accent: [156, 124, 79], rule: [207, 199, 184] };
  const W = 297, H = 210, M = 18, GAP = 2;
  const LOGO_RATIO = 1454 / 1590; // logo.svg viewBox

  const L = {
    pt: { sale: 'Para venda', ref: 'Referência', typology: 'Tipologia', area: 'Área útil', gross: 'Área bruta', plot: 'Terreno', beds: 'Quartos', baths: 'Casas de banho',
          floor: 'Piso', year: 'Ano de construção', energy: 'Certificado energético', exposure: 'Exposição solar', feature: 'Destaque',
          imi: 'IMI', imt: 'IMT', stamp: 'Imposto de selo', perYear: '/ano', desc: 'Descrição', areas: 'Áreas', features: 'Características',
          more: 'Mais informações', nearby: 'Distâncias', min: 'min', onRequest: 'Preço sob consulta', contact: 'Contacto' },
    en: { sale: 'For sale', ref: 'Reference', typology: 'Typology', area: 'Living area', gross: 'Gross area', plot: 'Plot', beds: 'Bedrooms', baths: 'Bathrooms',
          floor: 'Floor', year: 'Year built', energy: 'Energy certificate', exposure: 'Sun exposure', feature: 'Highlight',
          imi: 'IMI (property tax)', imt: 'IMT (transfer tax)', stamp: 'Stamp duty', perYear: '/year', desc: 'Description', areas: 'Areas', features: 'Features',
          more: 'More information', nearby: 'Nearby', min: 'min', onRequest: 'Price on request', contact: 'Contact' }
  };

  // ── data helpers ──
  function pick(p, lang) {
    const d = p.details || {};
    const i = d.i18n || {};
    const cur = i[lang] || {}, en = i.en || {};
    const g = k => ((Array.isArray(cur[k]) ? cur[k].length : cur[k]) ? cur[k] : en[k]);
    return {
      title: (lang === 'pt' ? p.title_pt : p.title) || p.title || '',
      desc: (lang === 'pt' ? p.description_pt : p.description) || p.description || '',
      feature: (lang === 'pt' ? p.feature_pt : p.feature) || p.feature || '',
      exposure: g('exposure') || '',
      features: g('features') || [],
      areas: g('areas') || [],
      nearby: g('nearby') || []
    };
  }
  const num = v => (v === null || v === undefined || v === '' ? '' : String(v));
  const money = v => '€ ' + Number(v).toLocaleString('de-DE');

  // ── image helpers ──
  function loadImage(url) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not load image ' + url));
      i.src = url;
    });
  }
  function cropJpeg(img, wMM, hMM) {
    const ppm = 7;
    const cw = Math.round(wMM * ppm), ch = Math.round(hMM * ppm);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    const s = Math.max(cw / img.width, ch / img.height);
    const dw = img.width * s, dh = img.height * s;
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
    g.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.82);
  }
  async function logoPng(url) {
    try {
      const img = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = 900; c.height = Math.round(900 * LOGO_RATIO);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  }

  function toBase64(buf) {
    const b = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function build(p, opts) {
    opts = opts || {};
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    const pt = pick(p, 'pt'), en = pick(p, 'en');
    const d = p.details || {};

    // same typefaces as the site: Marcellus headings, Aboreto wordmark, Inter body text (falls back to Helvetica)
    const F = { serif: 'helvetica', brand: 'helvetica', sans: 'helvetica' };
    try {
      for (const [key, file, name] of [['serif', 'Marcellus-Regular.ttf', 'Marcellus'], ['brand', 'Aboreto-Regular.ttf', 'Aboreto'], ['sans', 'Inter-Regular.ttf', 'Inter']]) {
        const res = await fetch((opts.fontBase || 'fonts/') + file);
        if (!res.ok) throw new Error('font ' + file);
        doc.addFileToVFS(file, toBase64(await res.arrayBuffer()));
        doc.addFont(file, name, 'normal');
        F[key] = name;
      }
    } catch (e) { console.warn('Brochure fonts not loaded, using Helvetica', e); }

    const imgs = [];
    for (const u of (opts.imageUrls || []).slice(0, 13)) { try { imgs.push(await loadImage(u)); } catch (e) { /* skip broken image */ } }
    const logo = await logoPng(opts.logoUrl || 'logo.svg');

    let first = true;
    const newPage = () => { if (first) first = false; else doc.addPage(); };
    const fill = (x, y, w, h, col) => { doc.setFillColor(...col); doc.rect(x, y, w, h, 'F'); };
    const pageNo = () => doc.getNumberOfPages();

    // text helper — returns the y after the block
    function txt(str, x, y, o) {
      o = o || {};
      if (str === undefined || str === null || str === '') return y;
      const fam = o.font || F.sans;
      doc.setFont(fam, fam === 'helvetica' && o.bold ? 'bold' : 'normal');
      doc.setFontSize(o.size || 9);
      doc.setTextColor(...(o.color || C.ink));
      if (doc.setCharSpace) doc.setCharSpace(o.spacing || 0);
      const lh = (o.size || 9) * 0.3528 * (o.lh || 1.45);
      const lines = o.max ? doc.splitTextToSize(String(str), o.max) : [String(str)];
      lines.forEach((ln, i) => doc.text(ln, x, y + i * lh, o.align ? { align: o.align } : undefined));
      if (doc.setCharSpace) doc.setCharSpace(0);
      return y + lines.length * lh;
    }
    const lines = (str, w, size) => { doc.setFont(F.sans, 'normal'); doc.setFontSize(size); return str ? doc.splitTextToSize(String(str), w) : []; };
    const logoAt = (x, y, w) => { if (logo) doc.addImage(logo, 'PNG', x, y, w, w * LOGO_RATIO); };
    const footer = (x) => {
      txt('ROYAL ESTATES', x === undefined ? M : x, H - 9, { font: F.brand, size: 8, color: C.ink, spacing: 0.6 });
      txt('AMI 23635   ·   ' + pageNo(), W - M, H - 9, { size: 7, color: C.mid, align: 'right', spacing: 0.2 });
    };

    // ── 1 · COVER: logo tile left, photo right ──
    newPage();
    fill(0, 0, W, H, C.bg);
    if (imgs[0]) doc.addImage(cropJpeg(imgs[0], 198, 210), 'JPEG', 99, 0, 198, 210); else fill(99, 0, 198, 210, C.deep);
    logoAt(12.5, 18, 74);
    let y = 128;
    y = txt(p.location, 12.5, y, { size: 8, color: C.mid, spacing: 0.3, max: 74 });
    y = txt(en.title, 12.5, y + 3, { font: F.serif, size: 18, max: 74, lh: 1.2, spacing: 0.3 });
    if (pt.title && pt.title !== en.title) y = txt(pt.title, 12.5, y + 3, { font: F.serif, size: 10, color: C.mid, max: 74, lh: 1.3, spacing: 0.2 });
    const price = p.price ? money(p.price) : null;
    txt(price || (L.en.onRequest + ' / ' + L.pt.onRequest), 12.5, 190, { font: F.serif, size: price ? 16 : 10, spacing: 0.4, max: 74 });

    // ── 2 · DESCRIPTION (PT | EN) with key facts on a gold tile ──
    const facts = [
      ['typology', p.typology], ['area', p.area ? p.area + ' m²' : ''], ['beds', num(d.bedrooms)], ['baths', num(d.bathrooms)],
      ['gross', d.gross_area ? d.gross_area + ' m²' : ''], ['plot', d.plot_area ? d.plot_area + ' m²' : ''], ['ref', d.reference]
    ].filter(f => f[1]);
    const colW = 78, x1 = 117, x2 = 207, top = 30, lhMM = 8.6 * 0.3528 * 1.55;
    const ptL = lines(pt.desc, colW, 8.6), enL = lines(en.desc, colW, 8.6);
    const perPage = Math.floor((H - top - 22) / lhMM);
    let pi = 0, ei = 0, firstDesc = true;
    do {
      newPage();
      fill(0, 0, W, H, C.bg);
      fill(0, 0, 99, H, C.accent);
      if (firstDesc) {
        txt(L.pt.sale + '  |  ' + L.en.sale, 12.5, 20, { size: 8, spacing: 0.3 });
        txt(price || '', 12.5, 38, { font: F.serif, size: 24, spacing: 0.5 });
        let fy = 56;
        facts.forEach(([k, v]) => {
          txt(L.pt[k] + ' / ' + L.en[k], 12.5, fy, { size: 7, spacing: 0.2, color: [60, 50, 35] });
          txt(v, 12.5, fy + 6.5, { font: F.serif, size: 13, spacing: 0.3 });
          fy += 18;
        });
      } else {
        txt(en.title, 12.5, 20, { font: F.serif, size: 12, max: 74, lh: 1.25, spacing: 0.2 });
      }
      txt(L.pt.desc.toUpperCase(), x1, top - 8, { font: F.serif, size: 9.5, color: C.accent, spacing: 0.9 });
      txt(L.en.desc.toUpperCase(), x2, top - 8, { font: F.serif, size: 9.5, color: C.accent, spacing: 0.9 });
      const trim = arr => { while (arr.length && arr[0].trim() === '') arr.shift(); return arr; };
      const ptChunk = trim(ptL.slice(pi, pi + perPage)), enChunk = trim(enL.slice(ei, ei + perPage));
      txt(ptChunk.join('\n'), x1, top, { size: 8.6, lh: 1.55, max: colW });
      txt(enChunk.join('\n'), x2, top, { size: 8.6, lh: 1.55, max: colW });
      pi += perPage; ei += perPage; firstDesc = false;
      footer(x1);
    } while (pi < ptL.length || ei < enL.length);

    // ── 3.. · PHOTO PAGES (edge-to-edge tiles) ──
    const rest = imgs.slice(1);
    for (let i = 0; i < rest.length; i += 4) {
      const g = rest.slice(i, i + 4);
      newPage();
      fill(0, 0, W, H, C.bg);
      const hw = (W - GAP) / 2, hh = (H - GAP) / 2;
      let boxes;
      if (g.length === 1) boxes = [[0, 0, W, H]];
      else if (g.length === 2) boxes = [[0, 0, hw, H], [hw + GAP, 0, hw, H]];
      else if (g.length === 3) boxes = [[0, 0, hw, H], [hw + GAP, 0, hw, hh], [hw + GAP, hh + GAP, hw, hh]];
      else boxes = [[0, 0, hw, hh], [hw + GAP, 0, hw, hh], [0, hh + GAP, hw, hh], [hw + GAP, hh + GAP, hw, hh]];
      g.forEach((img, k) => { const [bx, by, bw, bh] = boxes[k]; doc.addImage(cropJpeg(img, bw, bh), 'JPEG', bx, by, bw, bh); });
    }

    // ── DETAIL PAGES: Areas + Features, then More information + Nearby ──
    const cx1 = M, cx2 = 159, cw = 120;
    const heading = (y, key) => {
      txt(L.pt[key].toUpperCase(), cx1, y, { font: F.serif, size: 9.5, color: C.accent, spacing: 0.9 });
      txt(L.en[key].toUpperCase(), cx2, y, { font: F.serif, size: 9.5, color: C.accent, spacing: 0.9 });
      return y + 6;
    };
    const rowList = (x, y, items) => {
      items.forEach(([l, v]) => {
        txt(l, x, y, { size: 8.6 });
        if (v) txt(v, x + cw, y, { size: 8.6, align: 'right' });
        doc.setDrawColor(...C.rule); doc.setLineWidth(0.2); doc.line(x, y + 1.9, x + cw, y + 1.9);
        y += 6;
      });
      return y;
    };
    const textList = (x, y, arr) => txt(arr.join('  ·  '), x, y, { size: 8.6, max: cw, lh: 1.7 });

    let dpage = null, dy = 0;
    const ensure = need => {
      if (!dpage || dy + need > H - 20) {
        newPage(); fill(0, 0, W, H, C.bg); footer();
        dpage = pageNo(); dy = 24;
      }
    };
    const block = (key, ptItems, enItems, asText) => {
      const n = Math.max(ptItems.length, enItems.length);
      if (!n) return;
      const need = 14 + (asText ? 22 : n * 6);
      ensure(Math.min(need, 120));
      dy = heading(dy, key) + 3;
      const ey = asText ? Math.max(textList(cx1, dy, ptItems), textList(cx2, dy, enItems)) : Math.max(rowList(cx1, dy, ptItems), rowList(cx2, dy, enItems));
      dy = ey + 10;
    };

    const rowsA = lang => pick(p, lang).areas.map(a => [a.n, a.m ? String(a.m).replace('.', ',') + ' m²' : '']);
    block('areas', rowsA('pt'), rowsA('en'));
    block('features', pt.features, en.features, true);

    const more = lang => {
      const l = L[lang], x = pick(p, lang), out = [];
      if (d.floor) out.push([l.floor, num(d.floor)]);
      if (p.year) out.push([l.year, num(p.year)]);
      if (d.energy) out.push([l.energy, d.energy]);
      if (x.exposure) out.push([l.exposure, x.exposure]);
      if (d.imi) out.push([l.imi, money(d.imi) + l.perYear]);
      if (d.imt) out.push([l.imt, money(d.imt)]);
      if (d.stamp_duty) out.push([l.stamp, money(d.stamp_duty)]);
      return out;
    };
    block('more', more('pt'), more('en'));
    const near = lang => pick(p, lang).nearby.map(n => [n.n, n.min + ' ' + L[lang].min]);
    block('nearby', near('pt'), near('en'));

    // ── BACK COVER ──
    newPage();
    fill(0, 0, W, H, C.accent);
    logoAt(W / 2 - 38, 32, 76);
    txt('ROYAL ESTATES', W / 2, 132, { font: F.brand, size: 20, align: 'center', spacing: 1.6 });
    txt('info@royalestates.pt   ·   (+351) 964 480 190', W / 2, 152, { font: F.serif, size: 12, align: 'center', spacing: 0.5 });
    txt('Royal Estates Lda  ·  AMI 23635  ·  Rua Francisco Rocha, Lt 50, R/C, 2530-110 Lourinhã, Portugal', W / 2, 163, { size: 8, align: 'center', spacing: 0.2 });

    return doc.output('blob');
  }

  global.RepBrochure = { build, pick };
})(window);
