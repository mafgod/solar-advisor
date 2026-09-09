import { useEffect, useRef, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { goalLabel } from '../lib/defaults'
import { renderHouseViews } from '../lib/houseImage'
import { buildReportHtml, openProfessionalReport } from '../lib/report'
import { downloadStudyFile } from '../lib/storage'
import { dayToHalfHours, formatDayClock, MONTH_NAMES } from '../lib/solar'
import type { ClimateSummary, DaySim, GoalMode, StudyInput, StudyResult } from '../types'

interface Props {
  input: StudyInput
  result: StudyResult
}

function dayChartTitle(mode: GoalMode, useClimate: boolean): string {
  if (!useClimate) return 'Dia típico do modo escolhido'
  if (mode === 'winter' || mode === 'standby') return 'Dia nublado típico de inverno neste local'
  if (mode === 'summer') return 'Dia típico de verão neste local'
  return 'Dia típico de primavera neste local'
}

function climateBlurb(climate: ClimateSummary): string {
  const src =
    climate.source === 'tmy'
      ? 'ano meteorológico deste local'
      : 'perfil climático de referência'
  return `Com base no ${src}. O inverno usa um dia pobre (percentil 20 da irradiância), não céu limpo. A bateria prevê sequências nubladas e a perda de capacidade no frio.`
}

function monthName(month: number | undefined): string {
  if (!month || month < 1 || month > 12) return 'este mês'
  return MONTH_NAMES[month - 1]
}

function chartRows(day: DaySim[]) {
  return dayToHalfHours(day).map((d) => ({
    h: formatDayClock(d.hour),
    Consumo: Number(d.loadKwh.toFixed(3)),
    Solar: Number(d.pvKwh.toFixed(3)),
    Rede: Number(d.gridImportKwh.toFixed(3)),
    Exportação: Number(d.exportKwh.toFixed(3)),
    Bateria: Number(d.socKwh.toFixed(2)),
  }))
}

function HourTick({
  x,
  y,
  payload,
}: {
  x?: number
  y?: number
  payload?: { value: string }
}) {
  const v = payload?.value ?? ''
  if (!v.endsWith(':00')) return null
  const hour = Number(v.slice(0, 2))
  if (!Number.isFinite(hour) || hour % 2 !== 0) return null
  return (
    <text x={x} y={(y ?? 0) + 12} textAnchor="middle" fontSize={12} fill="#5c6778">
      {v}
    </text>
  )
}

function DayProfileChart({ day }: { day: DaySim[] }) {
  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartRows(day)} barCategoryGap="18%" barGap={1}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e7ee" />
          <XAxis dataKey="h" interval={0} tick={<HourTick />} height={36} />
          <YAxis tick={{ fontSize: 12, fill: '#5c6778' }} />
          <Tooltip />
          <Legend />
          <Bar dataKey="Consumo" fill="#5c6778" radius={[3, 3, 0, 0]} />
          <Bar dataKey="Solar" fill="#c4a574" radius={[3, 3, 0, 0]} />
          <Line type="monotone" dataKey="Bateria" stroke="#1a6b6b" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Rede" stroke="#9b1c1c" strokeWidth={1.5} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export function Results({ input, result }: Props) {
  const [layout, setLayout] = useState('')
  const [busyExport, setBusyExport] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    setLayout('')
    void renderHouseViews(input.location, result).then((views) => {
      if (!live.current) return
      setLayout(views.layout)
    })
    return () => {
      live.current = false
    }
  }, [input.location, result])

  const ready = Boolean(layout)
  const climate = input.goal.useClimate ? result.climate : undefined
  const dayBest = result.dayBest
  const dayWorst = result.dayWorst

  function exportReport() {
    if (!ready) return
    setBusyExport(true)
    try {
      openProfessionalReport(buildReportHtml(input, result, { house: layout, layout }))
    } finally {
      setBusyExport(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="report-actions no-print">
        <button type="button" className="btn-ghost" onClick={() => downloadStudyFile(input, result)}>
          Guardar estudo
        </button>
        <button type="button" className="btn" disabled={!ready || busyExport} onClick={exportReport}>
          {ready ? 'Exportar relatório' : 'A preparar imagens…'}
        </button>
      </div>

      <div className="kpi-grid">
        <Kpi label="Painéis" value={`${result.pvKwp.toFixed(2)} kWp`} hint={`${result.panelCount} × ${result.panelWatts} W`} />
        <Kpi
          label="Inversor híbrido"
          value={`${result.inverterKw} kW`}
          hint={
            input.consumption.inverterLimitKw != null
              ? `${result.inverterPhase === 'three' ? 'Trifásico' : 'Monofásico'} · teto ${input.consumption.inverterLimitKw} kW`
              : result.inverterPhase === 'three'
                ? 'Trifásico'
                : 'Monofásico'
          }
        />
        <Kpi
          label="Bateria"
          value={`${result.batteryKwh} kWh`}
          hint={`${result.usableBatteryKwh.toFixed(1)} kWh úteis (DoD 90 %)`}
        />
        <Kpi
          label="Autonomia da casa"
          value={input.goal.antiBlackout ? `${result.backupHoursEffective.toFixed(1)} h` : '—'}
          hint={
            input.goal.antiBlackout
              ? result.atsRequired
                ? 'ATS · quadro geral no backup'
                : 'On-grid'
              : 'Anti-apagão desligado'
          }
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Modo" value={goalLabel(input.goal)} />
        <Stat label="Produção anual" value={`${result.annualPvKwh.toFixed(0)} kWh`} />
        <Stat label="Autoconsumo (dia tipo)" value={`${result.selfConsumptionPct.toFixed(0)} %`} />
        <Stat
          label={input.goal.useClimate ? 'Cobertura em dia nublado' : 'Cobertura de inverno'}
          value={`${result.winterCoveragePct.toFixed(0)} %`}
        />
        <Stat label="Excedente de verão" value={`${result.summerExportKwhDay.toFixed(1)} kWh/dia`} />
        <Stat label="vs. orientação ótima" value={`${result.roofVsOptimalPct.toFixed(0)} %`} />
      </div>

      {climate && (
        <section className="card">
          <h3 className="section-title mb-3">Clima habitual neste local</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <Stat label="Inverno" value={`${climate.winterMeanTempC.toFixed(0)} °C`} />
            <Stat
              label="Irradiância de inverno"
              value={`${climate.winterMeanDailyGhi.toFixed(1)} kWh/m²`}
            />
            <Stat
              label="Dia pobre de inverno"
              value={`${climate.winterPoorDayGhi.toFixed(1)} kWh/m²`}
            />
            <Stat label="Dias nublados (Dez–Fev)" value={`${climate.winterCloudyDays}`} />
            <Stat
              label="Sequência nublada típica"
              value={`${climate.winterTypicalSpellDays} dia${climate.winterTypicalSpellDays === 1 ? '' : 's'}`}
            />
            <Stat label="Céu típico vs. limpo" value={`${climate.winterClearnessPct.toFixed(0)} %`} />
          </div>
          <p className="hint mt-3">{climateBlurb(climate)}</p>
        </section>
      )}

      <section className="card">
        <div className="mb-3">
          <h3 className="section-title">Implantação dos módulos</h3>
          <p className="hint">Vista aérea com a proposta de painéis sobre as águas marcadas no telhado.</p>
        </div>
        {ready ? (
          <figure className="house-single">
            <img src={layout} alt="Proposta de painéis sobre o telhado" className="house-img" />
            <figcaption>Implantação dos módulos</figcaption>
          </figure>
        ) : (
          <div className="skeleton">A obter a imagem de satélite e a sobrepor os módulos…</div>
        )}
      </section>

      <section className="card">
        <h3 className="section-title mb-1">{dayChartTitle(input.goal.mode, input.goal.useClimate)}</h3>
        <p className="hint mb-4">
          {input.goal.useClimate
            ? 'Perfil de produção na hora local da habitação, com o tempo habitual do local (não um dia de céu limpo). Intervalo de 30 minutos; barras em kWh por meia hora.'
            : 'Perfil de um dia médio do modo escolhido, na hora local da habitação, com a produção mensal do PVGIS. Intervalo de 30 minutos; barras em kWh por meia hora.'}
        </p>
        <DayProfileChart day={result.day} />
        {dayBest && dayBest.length > 0 && dayWorst && dayWorst.length > 0 && (
          <>
            <p className="notice">
              {input.goal.useClimate
                ? 'Atenção: o melhor e o pior dia não usam a previsão do clima, mesmo que a tenha selecionado para o cálculo do sistema. São um dia médio do mês mais e menos produtivo segundo o PVGIS, não um dia de céu limpo extremo nem um dia nublado.'
                : 'O melhor e o pior dia são um dia médio do mês mais e menos produtivo segundo o PVGIS, sem previsão de nublado nem de céu limpo extremo.'}
            </p>
            <h3 className="section-title mb-1 mt-8">
              Melhor dia — média de {monthName(result.bestMonth)}
            </h3>
            <p className="hint mb-4">
              Mês com maior produção média por kWp. Sem previsão do clima.
            </p>
            <DayProfileChart day={dayBest} />
            <h3 className="section-title mb-1 mt-8">
              Pior dia — média de {monthName(result.worstMonth)}
            </h3>
            <p className="hint mb-4">
              Mês com menor produção média por kWp. Sem previsão do clima.
            </p>
            <DayProfileChart day={dayWorst} />
          </>
        )}
      </section>

      <section className="card">
        <h3 className="section-title mb-3">Notas do estudo</h3>
        <ul className="notes">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{hint}</em>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
