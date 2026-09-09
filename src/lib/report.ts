import { goalLabel } from './defaults'
import { dayToHalfHours, formatDayClock, MONTH_NAMES } from './solar'
import { downloadBlob } from './storage'
import type { StudyInput, StudyResult } from '../types'

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  return d.toLocaleDateString('pt-PT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

function chartSvg(dayIn: { hour: number; loadKwh: number; pvKwh: number; socKwh: number }[]): string {
  const day = dayToHalfHours(dayIn)
  const w = 760
  const h = 220
  const pad = { l: 36, r: 12, t: 16, b: 28 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const max = Math.max(
    0.2,
    ...day.map((d) => Math.max(d.loadKwh, d.pvKwh, d.socKwh)),
  )
  const bw = innerW / day.length
  const y = (v: number) => pad.t + innerH - (v / max) * innerH
  const load = day
    .map((d, i) => {
      const bh = (d.loadKwh / max) * innerH
      return `<rect x="${pad.l + i * bw + 1}" y="${y(d.loadKwh)}" width="${bw * 0.38}" height="${bh}" fill="#5c6778" rx="1"/>`
    })
    .join('')
  const solar = day
    .map((d, i) => {
      const bh = (d.pvKwh / max) * innerH
      return `<rect x="${pad.l + i * bw + bw * 0.42}" y="${y(d.pvKwh)}" width="${bw * 0.38}" height="${bh}" fill="#c4a574" rx="1"/>`
    })
    .join('')
  const bat = day
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${pad.l + i * bw + bw / 2} ${y(d.socKwh)}`)
    .join(' ')
  const labels = day
    .map((d, i) => {
      if (d.hour % 2 !== 0) return ''
      return `<text x="${pad.l + i * bw + bw / 2}" y="${h - 8}" text-anchor="middle" fill="#7a8494" font-size="9">${formatDayClock(d.hour)}</text>`
    })
    .join('')
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" xmlns="http://www.w3.org/2000/svg">${load}${solar}<path d="${bat}" fill="none" stroke="#1a6b6b" stroke-width="1.8"/>${labels}</svg>`
}

export function buildReportHtml(
  input: StudyInput,
  result: StudyResult,
  images: { house: string; layout: string },
): string {
  const addr = esc(input.location.address || 'Habitação')
  const notes = result.notes.map((n) => `<li>${esc(n)}</li>`).join('')
  const daily = input.consumption.hourlyKwh.reduce((a, b) => a + b, 0)
  const climate = input.goal.useClimate ? result.climate : undefined
  const climateBlock = climate
    ? `<h2>Clima habitual neste local</h2>
    <div class="stats">
      <div class="stat"><span>Inverno</span><strong>${climate.winterMeanTempC.toFixed(0)} °C</strong></div>
      <div class="stat"><span>Irradiância de inverno</span><strong>${climate.winterMeanDailyGhi.toFixed(1)} kWh/m²·dia</strong></div>
      <div class="stat"><span>Dia pobre de inverno</span><strong>${climate.winterPoorDayGhi.toFixed(1)} kWh/m²</strong></div>
      <div class="stat"><span>Dias nublados (Dez–Fev)</span><strong>${climate.winterCloudyDays}</strong></div>
      <div class="stat"><span>Sequência nublada típica</span><strong>${climate.winterTypicalSpellDays} dia${climate.winterTypicalSpellDays === 1 ? '' : 's'}</strong></div>
      <div class="stat"><span>Céu típico vs. limpo</span><strong>${climate.winterClearnessPct.toFixed(0)} %</strong></div>
    </div>
    <p class="muted">O dimensionamento usa o ano meteorológico tipo (PVGIS TMY): dia pobre de inverno, não céu limpo. A bateria prevê sequências nubladas e a perda de capacidade no frio.</p>`
    : ''

  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8"/>
  <title>CasaSolar — ${addr}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #152033;
      font: 12.5px/1.45 Manrope, "Segoe UI", sans-serif;
      background: #fff;
    }
    .page { max-width: 920px; margin: 0 auto; padding: 28px 32px 48px; }
    header.brand {
      display: flex; justify-content: space-between; align-items: flex-end;
      border-bottom: 3px solid #0f2744; padding-bottom: 14px; margin-bottom: 22px;
    }
    .name { font-family: Fraunces, Georgia, serif; font-size: 28px; color: #0f2744; letter-spacing: -0.03em; }
    .sub { color: #7a5c2e; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
    .meta { text-align: right; color: #5c6778; font-size: 12px; }
    h1 { font-size: 22px; margin: 0 0 6px; color: #0f2744; }
    h2 { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: #7a5c2e; margin: 28px 0 10px; border-bottom: 1px solid #e2e7ee; padding-bottom: 6px; }
    .lede { color: #5c6778; margin: 0 0 18px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .kpi { background: #0f2744; color: #f4f1ea; padding: 12px; border-top: 3px solid #c4a574; }
    .kpi span { display: block; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #9eb0c2; }
    .kpi strong { display: block; font-size: 20px; margin-top: 6px; font-family: Fraunces, Georgia, serif; }
    .kpi em { font-style: normal; color: #d4c3a3; font-size: 11px; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
    .stat { border: 1px solid #e2e7ee; padding: 10px 12px; background: #f7f9fb; }
    .stat span { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #7a8494; }
    .stat strong { font-size: 15px; color: #0f2744; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .pair figure { margin: 0; }
    .pair img { width: 100%; display: block; border: 1px solid #d8dee6; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e2e7ee; padding: 8px 6px; text-align: left; vertical-align: top; }
    th { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #7a8494; }
    .muted { color: #7a8494; font-size: 11px; margin-top: 2px; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 4px 0; }
    footer.legal { margin-top: 28px; font-size: 11px; color: #7a8494; border-top: 1px solid #e2e7ee; padding-top: 12px; }
    .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin: 12px 0 18px; color: #3d4a5c; }
    .toolbar {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      background: #f3f7fb; border: 1px solid #d8dee6; padding: 10px 12px; margin-bottom: 18px;
    }
    .toolbar button {
      background: #0f2744; color: #f4f1ea; border: 0; padding: 8px 14px; font: inherit; cursor: pointer;
    }
    @media print {
      .page { padding: 0; max-width: none; }
      .kpi, .stat, .pair figure, table, ul { break-inside: avoid; }
      .toolbar { display: none; }
    }
    @page { size: A4; margin: 12mm; }
  </style>
</head>
<body>
  <div class="page">
    <div class="toolbar">
      <span>Relatório CasaSolar — use Imprimir e escolha «Guardar como PDF» para arquivar.</span>
      <button type="button" onclick="window.print()">Imprimir / PDF</button>
    </div>
    <header class="brand">
      <div>
        <div class="sub">Estudo de autoconsumo residencial</div>
        <div class="name">CasaSolar</div>
      </div>
      <div class="meta">
        ${fmtDate()}<br/>
        Pré-dimensionamento indicativo
      </div>
    </header>
    <h1>${addr}</h1>
    <p class="lede">
      ${input.location.lat.toFixed(5)}, ${input.location.lon.toFixed(5)}
      · ${input.location.zones.length} água${input.location.zones.length === 1 ? '' : 's'}
      · ${input.location.availableAreaM2.toFixed(1)} m²
      · inclinação ${input.location.roofTiltDeg}°
    </p>
    <div class="facts">
      <div>Modo: <strong>${esc(goalLabel(input.goal))}</strong></div>
      <div>Consumo médio: <strong>${daily.toFixed(1)} kWh/dia</strong></div>
      <div>Ramal: <strong>${input.consumption.phase === 'three' ? 'Trifásico' : 'Monofásico'} · ${input.consumption.contractedPowerKva} kVA</strong></div>
      <div>Teto do inversor: <strong>${input.consumption.inverterLimitKw != null ? `${input.consumption.inverterLimitKw} kW AC` : 'Sem teto extra'}</strong></div>
      <div>VE: <strong>${input.ev.enabled ? 'Sim' : 'Não'}</strong></div>
      <div>Previsão do clima: <strong>${input.goal.useClimate ? 'Ligada' : 'Desligada'}</strong></div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Painéis</span><strong>${result.pvKwp.toFixed(2)} kWp</strong><em>${result.panelCount} × ${result.panelWatts} W</em></div>
      <div class="kpi"><span>Inversor híbrido</span><strong>${result.inverterKw} kW</strong><em>${result.inverterPhase === 'three' ? 'Trifásico' : 'Monofásico'}${input.consumption.inverterLimitKw != null ? ` · teto ${input.consumption.inverterLimitKw} kW` : ''}</em></div>
      <div class="kpi"><span>Bateria</span><strong>${result.batteryKwh} kWh</strong><em>${result.usableBatteryKwh.toFixed(1)} kWh úteis</em></div>
      <div class="kpi"><span>Autonomia da casa</span><strong>${input.goal.antiBlackout ? `${result.backupHoursEffective.toFixed(1)} h` : '—'}</strong><em>${input.goal.antiBlackout ? (result.atsRequired ? 'ATS · quadro geral no backup' : 'On-grid') : 'Anti-apagão desligado'}</em></div>
    </div>
    <div class="stats">
      <div class="stat"><span>Produção anual</span><strong>${result.annualPvKwh.toFixed(0)} kWh</strong></div>
      <div class="stat"><span>Autoconsumo (dia tipo)</span><strong>${result.selfConsumptionPct.toFixed(0)} %</strong></div>
      <div class="stat"><span>${input.goal.useClimate ? 'Cobertura em dia nublado' : 'Cobertura de inverno'}</span><strong>${result.winterCoveragePct.toFixed(0)} %</strong></div>
      <div class="stat"><span>Excedente de verão</span><strong>${result.summerExportKwhDay.toFixed(1)} kWh/dia</strong></div>
      <div class="stat"><span>vs. orientação ótima</span><strong>${result.roofVsOptimalPct.toFixed(0)} %</strong></div>
      <div class="stat"><span>Produtividade</span><strong>${result.specificYield.toFixed(0)} kWh/kWp·ano</strong></div>
    </div>
    ${climateBlock}
    <h2>Implantação dos módulos</h2>
    <figure><img src="${images.layout}" alt="Proposta de painéis sobre o telhado"/></figure>
    <h2>${input.goal.useClimate ? 'Dia típico com o clima do local' : 'Dia típico do modo escolhido'}</h2>
    ${chartSvg(result.day)}
    <p class="muted">${
      input.goal.useClimate
        ? 'Barras cinzentas: consumo. Barras douradas: solar com o tempo habitual (não céu limpo). Linha verde: estado de carga da bateria. Intervalo de 30 minutos (kWh por meia hora).'
        : 'Barras cinzentas: consumo. Barras douradas: solar. Linha verde: estado de carga da bateria. Intervalo de 30 minutos (kWh por meia hora).'
    }</p>
    ${
      result.dayBest?.length && result.dayWorst?.length
        ? `<p class="muted">${
            input.goal.useClimate
              ? 'Atenção: o melhor e o pior dia não usam a previsão do clima, mesmo que a tenha selecionado para o cálculo do sistema. São um dia médio do mês mais e menos produtivo segundo o PVGIS.'
              : 'O melhor e o pior dia são um dia médio do mês mais e menos produtivo segundo o PVGIS, sem previsão de nublado.'
          }</p>
    <h2>Melhor dia — média de ${MONTH_NAMES[(result.bestMonth ?? 7) - 1] ?? ''}</h2>
    ${chartSvg(result.dayBest)}
    <h2>Pior dia — média de ${MONTH_NAMES[(result.worstMonth ?? 12) - 1] ?? ''}</h2>
    ${chartSvg(result.dayWorst)}`
        : ''
    }
    <h2>Notas do estudo</h2>
    <ul>${notes}</ul>
    <footer class="legal">
      Documento gerado pelo CasaSolar. Os valores são um pré-dimensionamento com base no PVGIS${input.goal.useClimate ? ' (incluindo o clima típico do local)' : ''}, no telhado marcado e no consumo declarado.
      Não substituem projeto certificado, visita técnica nem o cumprimento da regulamentação aplicável.
      Informações ou sugestões: mafgod@hotmail.com
    </footer>
  </div>
</body>
</html>`
}

export function openProfessionalReport(html: string): void {
  const popup = window.open('', '_blank')
  if (!popup) {
    const blob = new Blob([html], { type: 'text/html' })
    downloadBlob('casasolar-relatorio.html', blob)
    return
  }
  popup.document.open()
  popup.document.write(html)
  popup.document.close()
}
