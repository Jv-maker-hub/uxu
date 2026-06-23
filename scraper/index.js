/**
 * UNO × UNO — Scraper de ads de competidores
 * Fuente: Meta Ads Library API (search_page_ids)
 * Destino: Supabase (tablas ads, ad_snapshots) + Storage (imágenes)
 */

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// ── Configuración ──────────────────────────────────────────────────────────
const META_TOKEN   = process.env.META_ACCESS_TOKEN;
const SUPA_URL     = process.env.SUPABASE_URL;
const SUPA_KEY     = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN      = process.argv.includes('--dry-run');
const API_VERSION  = 'v19.0';

const WebSocket = require('ws');
const supabase = createClient(SUPA_URL, SUPA_KEY, {
  global: { WebSocket },
});

// ── Competidores con page IDs reales ──────────────────────────────────────
const COMPETITORS = [
  {
    slug:        'tecla',
    name:        'TECLA',
    pageIds:     ['102329249357803'],
    libraryUrl:  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=102329249357803',
  },
  {
    slug:        'valfort',
    name:        'VALFORT',
    pageIds:     ['740480865810440'],
    libraryUrl:  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=740480865810440',
  },
  {
    slug:        'umano',
    name:        'UMANO',
    pageIds:     ['295781300274660'],
    libraryUrl:  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=295781300274660',
  },
  {
    slug:        'ser-basics',
    name:        'SER BASICS',
    pageIds:     ['122859739497984'],
    libraryUrl:  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=122859739497984',
  },
  {
    // Elemental pauta mayormente desde "El Calce Argentino" (1035888372948586)
    // también tiene página propia (421257577744593) — ambas se rastrean
    slug:        'elemental',
    name:        'ELEMENTAL OUTFIT',
    pageIds:     ['421257577744593', '1035888372948586'],
    libraryUrl:  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=421257577744593',
  },
  {
    // Club Básico — vende con dominio todoimportado.store
    slug:        'club-basico',
    name:        'CLUB BÁSICO',
    pageIds:     ['156367830894050'],
    libraryUrl:  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&search_type=page&view_all_page_id=156367830894050',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchAdsForPageIds(pageIds) {
  const allAds = [];
  for (const pageId of pageIds) {
    const params = new URLSearchParams({
      search_page_ids: pageId,
      ad_type:         'ALL',
      ad_reached_countries: 'AR',
      ad_active_status: 'ACTIVE',
      fields: [
        'id', 'page_id', 'page_name',
        'ad_creative_bodies',
        'ad_creative_link_captions',
        'ad_creative_link_titles',
        'ad_snapshot_url',
        'ad_delivery_start_time',
        'ad_delivery_stop_time',
        'creative_platforms',
        'impressions',
      ].join(','),
      limit: '50',
      access_token: META_TOKEN,
    });

    const url = `https://graph.facebook.com/${API_VERSION}/ads_archive?${params}`;
    const res  = await fetch(url);
    const json = await res.json();

    if (json.error) {
      console.warn(`  ⚠ API error for page ${pageId}: ${json.error.message}`);
      continue;
    }

    const ads = json.data || [];
    console.log(`  → Page ${pageId}: ${ads.length} ads encontrados`);
    allAds.push(...ads);

    // Paginación (hasta 200 ads por competidor)
    let next = json.paging?.next;
    let page = 1;
    while (next && allAds.length < 200 && page < 4) {
      const r  = await fetch(next);
      const j  = await r.json();
      allAds.push(...(j.data || []));
      next = j.paging?.next;
      page++;
    }
  }
  return allAds;
}

async function downloadImage(url, slug, adId) {
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return null;
    const buffer = await res.buffer();
    const path   = `${slug}/${adId}.jpg`;
    if (DRY_RUN) return `https://dry-run-placeholder/${path}`;
    const { error } = await supabase.storage
      .from('competitor-ads')
      .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
    if (error) { console.warn(`    Storage error: ${error.message}`); return null; }
    const { data } = supabase.storage.from('competitor-ads').getPublicUrl(path);
    return data.publicUrl;
  } catch (e) {
    console.warn(`    Image download failed: ${e.message}`);
    return null;
  }
}

function extractCopy(ad) {
  const bodies = ad.ad_creative_bodies || [];
  return bodies[0] || ad.ad_creative_link_titles?.[0] || '';
}

async function main() {
  console.log(`\n🔍 UNO × UNO — Scraper de ads competidores`);
  console.log(`   Modo: ${DRY_RUN ? 'DRY RUN' : 'PRODUCCIÓN'}`);
  console.log(`   Fecha: ${new Date().toISOString()}\n`);
  const today = new Date().toISOString().split('T')[0];
  const { data: dbCompetitors, error: dbErr } = await supabase
    .from('competitors')
    .select('id, slug, name');
  if (dbErr) { console.error('Error leyendo competitors:', dbErr); process.exit(1); }
  const competitorMap = Object.fromEntries(dbCompetitors.map(c => [c.slug, c]));
  for (const comp of COMPETITORS) {
    console.log(`\n── ${comp.name} ──`);
    const dbComp = competitorMap[comp.slug];
    if (!dbComp) {
      console.warn(`  ⚠ Competidor ${comp.slug} no encontrado en DB — saltando`);
      continue;
    }
    const metaAds = await fetchAdsForPageIds(comp.pageIds);
    console.log(`  Total ads activos: ${metaAds.length}`);
    if (DRY_RUN) {
      console.log(`  [DRY RUN] Saltando escritura en DB`);
      await supabase.from('ad_snapshots').upsert({
        competitor_id: dbComp.id, snapshot_date: today,
        active_ads_count: metaAds.length, raw_data: { dry_run: true },
      }, { onConflict: 'competitor_id,snapshot_date' });
      continue;
    }
    const activeAdIds = [];
    for (const ad of metaAds) {
      const adId = String(ad.id);
      const copy = extractCopy(ad);
      const snapUrl = ad.ad_snapshot_url || null;
      let imageUrl = null;
      if (snapUrl) imageUrl = await downloadImage(snapUrl, comp.slug, adId);
      const { error: upsertErr } = await supabase.from('ads').upsert({
        competitor_id: dbComp.id, meta_ad_id: adId,
        page_id: String(ad.page_id || comp.pageIds[0]),
        page_name: ad.page_name || comp.name,
        ad_copy: copy, ad_snapshot_url: snapUrl, image_url: imageUrl,
        delivery_start_date: ad.ad_delivery_start_time?.split('T')[0] || null,
        delivery_stop_date: ad.ad_delivery_stop_time?.split('T')[0] || null,
        is_active: true, first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'meta_ad_id', ignoreDuplicates: false });
      if (upsertErr) console.warn(`    Upsert error ad ${adId}: ${upsertErr.message}`);
      else activeAdIds.push(adId);
    }
    if (activeAdIds.length > 0) {
      const { error: deactErr } = await supabase
        .from('ads')
        .update({ is_active: false, last_seen_at: new Date().toISOString() })
        .eq('competitor_id', dbComp.id).eq('is_active', true)
        .not('meta_ad_id', 'in', `(${activeAdIds.map(id => `"${id}"`).join(',')})`);
      if (deactErr) console.warn(`  Deactivation error: ${deactErr.message}`);
    }
    const { error: snapErr } = await supabase.from('ad_snapshots').upsert({
      competitor_id: dbComp.id, snapshot_date: today,
      active_ads_count: metaAds.length,
      raw_data: { page_ids: comp.pageIds, ad_count: metaAds.length },
    }, { onConflict: 'competitor_id,snapshot_date' });
    if (snapErr) console.warn(`  Snapshot error: ${snapErr.message}`);
    else console.log(`  ✅ Snapshot guardado (${metaAds.length} ads)`);
  }
  console.log(`\n🎉 Scraper finalizado`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
