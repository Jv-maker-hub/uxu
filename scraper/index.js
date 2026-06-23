/**
 * UNO × UNO — Scraper con Playwright
 * Navega la Ads Library de Meta en modo headless.
 * No requiere Meta API token. Captura TODOS los ads con tipo creativo.
 * Corre diariamente via GitHub Actions.
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN     = process.argv.includes('--dry-run');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Competidores ─────────────────────────────────────────────────────────────
const COMPETITORS = [
  {
    slug: 'tecla',
    urls: [
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=Tecla+remera&search_type=keyword_unordered',
    ],
    filterNames: ['Tecla', 'tecla'],
  },
  {
    slug: 'valfort',
    urls: [
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=61578561641262',
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=Valfort+remera&search_type=keyword_unordered',
    ],
    filterNames: ['Valfort', 'valfort'],
  },
  {
    slug: 'umano',
    urls: [
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=Umano+remera&search_type=keyword_unordered',
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=umano.ar&search_type=keyword_unordered',
    ],
    filterNames: ['Umano', 'umano'],
  },
  {
    slug: 'ser-basics',
    urls: [
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=SER+Basics+remera&search_type=keyword_unordered',
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=ser+basics+pack&search_type=keyword_unordered',
    ],
    filterNames: ['SER', 'Ser Basics', 'SER BASICS', 'serbasics'],
  },
  {
    slug: 'elemental',
    urls: [
      // El Calce Argentino — page ID correcto (verificado Jun 2026)
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=1035888372948586',
      // Keywords como fallback
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=elemental+outfit&search_type=keyword_unordered',
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=El+Calce+Argentino&search_type=keyword_unordered',
    ],
    filterNames: null,
  },
  {
    slug: 'club-basico',
    urls: [
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=156367830894050',
    ],
    filterNames: null,
  },
];

// ── Parseo de fecha en español ────────────────────────────────────────────────
function parseSpanishDate(str) {
  const MONTHS = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12 };
  const m = str.match(/(\d{1,2})\s+(\w{3})\w*\s+(\d{4})/i);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

// ── Extraer ads del texto de la página ───────────────────────────────────────
function extractAdsFromText(text, filterNames) {
  const sections = text.split('Identificador de la biblioteca:').slice(1);
  const seen     = new Set();
  const ads      = [];

  for (const section of sections) {
    const idMatch = section.match(/^\s*(\d{10,20})/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // Tipo creativo por heurística de texto
    const isVideo    = /\d+:\d+\s*\/\s*\d+:\d+/.test(section);
    const isCarousel = !isVideo && /\bcarrusel\b|\bcarousel\b/i.test(section);
    const creativeType = isVideo ? 'video' : isCarousel ? 'carousel' : 'photo';

    // Nombre de página (línea antes de "Publicidad")
    const pageNameMatch = section.match(/\n([^\n]{2,80})\nPublicidad\n/);
    const pageName      = pageNameMatch?.[1]?.trim() || '';

    if (filterNames && !filterNames.some(f => pageName.toLowerCase().includes(f.toLowerCase()))) {
      continue;
    }

    // Copy del ad
    const pubIdx = section.indexOf('\nPublicidad\n');
    let copy = '';
    if (pubIdx !== -1) {
      copy = section.substring(pubIdx + '\nPublicidad\n'.length);
      copy = copy.replace(/\n(https?:\/\/|www\.|SHOP NOW|Comprar ahora|Ver más ahora|Realizar pedido|Aprovechar|Contactar|Más información|Registrarte|Obtener oferta).*/s, '');
      copy = copy.trim().substring(0, 700);
    }

    // Fechas
    const startMatch = section.match(/En circulación desde el ([^\n]+)/);
    const stopMatch  = section.match(/Hasta el ([^\n]+)/);
    const startDate  = startMatch ? parseSpanishDate(startMatch[1]) : null;
    const stopDate   = stopMatch  ? parseSpanishDate(stopMatch[1])  : null;
    const isActive   = !section.match(/\nInactivo\n|\nInactive\n/);

    ads.push({ id, pageName, copy, startDate, stopDate, isActive, creativeType });
  }

  return ads;
}

// ── Auto-scroll para cargar todos los ads ────────────────────────────────────
async function autoScroll(page) {
  let prevHeight = 0;
  let unchanged  = 0;

  for (let i = 0; i < 40; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (height === prevHeight) {
      unchanged++;
      if (unchanged >= 3) break;
    } else {
      unchanged = 0;
    }
    prevHeight = height;

    // Scroll incremental más humano
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(300 + Math.random() * 400));
    });
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 800));

    if (i % 3 === 0) {
      // Full scroll + pausa extra cada 3 iteraciones
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
    }

    // Click "Ver más" si existe
    const btn = await page.$('div[role="button"]:has-text("Ver más resultados"), button:has-text("Ver más"), button:has-text("Load more")').catch(() => null);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
}

// ── Dismiss overlays (cookie banners, login prompts) ─────────────────────────
async function dismissOverlays(page) {
  const selectors = [
    'button:has-text("Rechazar cookies")',
    'button:has-text("Rechazar todo")',
    'button:has-text("Solo cookies esenciales")',
    'button:has-text("Cerrar")',
    '[aria-label="Cerrar"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click().catch(() => {}); await page.waitForTimeout(500); }
  }
}

// ── Detección DOM de tipo creativo (override sobre heurística de texto) ───────
async function detectCreativeTypesDOM(page) {
  return page.evaluate(() => {
    const types = {};

    // Videos: <video> elements
    document.querySelectorAll('video').forEach(v => {
      let el = v;
      for (let i = 0; i < 12; i++) {
        el = el.parentElement;
        if (!el) break;
        const m = el.innerText?.match(/Identificador de la biblioteca:\s*(\d{10,20})/);
        if (m) { types[m[1]] = 'video'; break; }
      }
    });

    // Carrusel: botones de navegación
    document.querySelectorAll('[aria-label*="siguiente"], [aria-label*="Siguiente"], [aria-label*="next"], [aria-label*="Next"], [aria-label*="anterior"], [aria-label*="Previous"]')
      .forEach(btn => {
        let el = btn;
        for (let i = 0; i < 12; i++) {
          el = el.parentElement;
          if (!el) break;
          const m = el.innerText?.match(/Identificador de la biblioteca:\s*(\d{10,20})/);
          if (m && !types[m[1]]) { types[m[1]] = 'carousel'; break; }
        }
      });

    return types;
  });
}

// ── Upsert en Supabase ────────────────────────────────────────────────────────
async function upsertAds(competitorId, ads, today) {
  if (!ads.length) return;

  for (const ad of ads) {
    const { error } = await supabase.from('ads').upsert({
      competitor_id:       competitorId,
      meta_ad_id:          ad.id,
      page_id:             '',
      page_name:           ad.pageName,
      ad_copy:             ad.copy,
      creative_type:       ad.creativeType,
      delivery_start_date: ad.startDate,
      delivery_stop_date:  ad.stopDate,
      is_active:           ad.isActive,
      first_seen_at:       new Date().toISOString(),
      last_seen_at:        new Date().toISOString(),
    }, { onConflict: 'meta_ad_id', ignoreDuplicates: false });
    if (error) console.warn(`  ⚠ upsert ${ad.id}: ${error.message}`);
  }

  // Desactivar ads que no aparecieron en este run
  const activeIds = ads.filter(a => a.isActive).map(a => a.id);
  if (activeIds.length > 0) {
    await supabase
      .from('ads')
      .update({ is_active: false, last_seen_at: new Date().toISOString() })
      .eq('competitor_id', competitorId)
      .eq('is_active', true)
      .not('meta_ad_id', 'in', `(${activeIds.map(id => `"${id}"`).join(',')})`);
  }

  // Snapshot diario
  const byType = ads.reduce((acc, a) => {
    acc[a.creativeType] = (acc[a.creativeType] || 0) + 1;
    return acc;
  }, {});
  await supabase.from('ad_snapshots').upsert({
    competitor_id:    competitorId,
    snapshot_date:    today,
    active_ads_count: activeIds.length,
    raw_data:         { total: ads.length, by_type: byType },
  }, { onConflict: 'competitor_id,snapshot_date' });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 UNO × UNO — Scraper Playwright`);
  console.log(`  Modo: ${DRY_RUN ? 'DRY RUN' : 'PRODUCCIÓN'}`);
  console.log(`  Fecha: ${new Date().toISOString()}\n`);

  const today = new Date().toISOString().split('T')[0];

  const { data: dbComps, error: dbErr } = await supabase.from('competitors').select('id,slug,name');
  if (dbErr) { console.error('Error DB:', dbErr); process.exit(1); }
  const compMap = Object.fromEntries(dbComps.map(c => [c.slug, c]));

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
  });
  const context = await browser.newContext({
    locale:    'es-AR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
    viewport:  { width: 1440, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8' },
  });
  // Ocultar fingerprint de Playwright/webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-AR', 'es', 'en'] });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();

  for (const comp of COMPETITORS) {
    const dbComp = compMap[comp.slug];
    if (!dbComp) { console.warn(`⚠ ${comp.slug} no en DB`); continue; }

    console.log(`\n── ${dbComp.name.toUpperCase()} ──`);
    const allAds  = [];
    const seenIds = new Set();

    for (const url of comp.urls) {
      console.log(`  → ${url.slice(0, 90)}...`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        await dismissOverlays(page);
        await page.waitForTimeout(2500);
        await autoScroll(page);

        const text = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (!text.includes('Identificador de la biblioteca')) {
          console.log(`  ⚠ Sin resultados`);
          continue;
        }

        const textAds  = extractAdsFromText(text, comp.filterNames);
        const domTypes = await detectCreativeTypesDOM(page).catch(() => ({}));

        let newCount = 0;
        for (const ad of textAds) {
          if (seenIds.has(ad.id)) continue;
          seenIds.add(ad.id);
          if (domTypes[ad.id]) ad.creativeType = domTypes[ad.id];
          allAds.push(ad);
          newCount++;
        }
        console.log(`  ✓ ${newCount} ads (acum: ${allAds.length})`);
      } catch (e) {
        console.warn(`  ✗ ${e.message.slice(0, 100)}`);
      }
    }

    const byType = allAds.reduce((a, x) => { a[x.creativeType] = (a[x.creativeType]||0)+1; return a; }, {});
    console.log(`  Total: ${allAds.length} — ${JSON.stringify(byType)}`);

    if (!DRY_RUN && allAds.length > 0) {
      await upsertAds(dbComp.id, allAds, today);
      console.log(`  ✅ Guardado en Supabase`);
    } else if (DRY_RUN) {
      console.log(`  [DRY RUN] No se escribe en DB`);
    }
  }

  await browser.close();
  console.log(`\n🎉 Scraper finalizado`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
