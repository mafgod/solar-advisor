import { useRef, useState } from 'react'
import { publicUrl } from '../lib/endpoints'
import { parseEredesFile } from '../lib/eredes'
import { defaultHourlyProfile } from '../lib/sizing'
import type { ConsumptionInput } from '../types'

const PRESETS = [
  { id: 'apt', label: 'Apartamento', kwh: 6.5 },
  { id: 'house', label: 'Moradia', kwh: 11 },
  { id: 'ac', label: 'Moradia + AC', kwh: 16 },
  { id: 'hp', label: 'Bomba de calor', kwh: 22 },
]

interface Props {
  value: ConsumptionInput
  onChange: (next: ConsumptionInput) => void
}

export function ConsumptionForm({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const daily = value.hourlyKwh.reduce((a, b) => a + b, 0)

  function patch(partial: Partial<ConsumptionInput>) {
    onChange({ ...value, ...partial })
  }

  function setHour(i: number, kwh: number) {
    const hourlyKwh = [...value.hourlyKwh]
    hourlyKwh[i] = Math.max(0, kwh)
    patch({ hourlyKwh, source: 'manual' })
  }

  function applyDaily(total: number) {
    patch({
      hourlyKwh: defaultHourlyProfile(total),
      source: 'manual',
      monthlyDailyKwh: new Array(12).fill(0),
    })
  }

  async function onFile(file: File) {
    setError('')
    try {
      const parsed = await parseEredesFile(file)
      patch({
        source: 'eredes',
        fileName: parsed.fileName,
        hourlyKwh: parsed.hourlyKwh,
        monthlyDailyKwh: parsed.monthlyDailyKwh,
      })
      setInfo(parsed.note)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ficheiro inválido')
    }
  }

  return (
    <div className="space-y-6">
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void onFile(file)
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onFile(file)
          }}
        />
        <div className="dropzone-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <strong>Importar dados e-redes</strong>
        <p>
          Largue aqui o Excel de Leituras ou Consumos do Balcão Digital.{' '}
          <a href={publicUrl('exemplos/eredes-exemplo.csv')} download onClick={(e) => e.stopPropagation()}>
            CSV de exemplo
          </a>
        </p>
      </div>
      {info && <p className="ok">{info}</p>}
      {error && <p className="err">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="chip" onClick={() => applyDaily(p.kwh)}>
            {p.label} · {p.kwh} kWh/dia
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="label">
          Total diário (kWh)
          <input
            type="number"
            min={1}
            step={0.5}
            className="field"
            value={Number(daily.toFixed(2))}
            onChange={(e) => applyDaily(Number(e.target.value))}
          />
        </label>
        <label className="label">
          Potência contratada (kVA)
          <input
            type="number"
            min={3.45}
            step={1.15}
            className="field"
            value={value.contractedPowerKva}
            onChange={(e) => patch({ contractedPowerKva: Number(e.target.value) })}
          />
        </label>
        <label className="label">
          Fase
          <select
            className="field"
            value={value.phase}
            onChange={(e) => patch({ phase: e.target.value as ConsumptionInput['phase'] })}
          >
            <option value="single">Monofásico</option>
            <option value="three">Trifásico</option>
          </select>
          <span className="meta">
            O inversor e o ATS seguem o ramal da casa: monofásico nunca gera uma proposta trifásica.
          </span>
        </label>
        <label className="label md:col-span-3">
          Standby estimado (W contínuos)
          <input
            type="number"
            min={40}
            step={10}
            className="field"
            value={value.standbyW}
            onChange={(e) => patch({ standbyW: Number(e.target.value) })}
          />
          <span className="meta">
            Router, alarme, eletrodomésticos em espera. Usado no modo «apenas eliminar o standby».
          </span>
        </label>
      </div>

      <div>
        <p className="meta mb-2">Ligação à rede</p>
        <button
          type="button"
          className={value.inverterLimitKw != null ? 'mode on' : 'mode'}
          onClick={() =>
            patch({ inverterLimitKw: value.inverterLimitKw != null ? null : 4 })
          }
        >
          <span className="mode-title">Limitar potência do inversor</span>
          <span>
            Acima de 4 kW AC a E-REDES exige normalmente um contador de produção extra e comunicações (SIM) para as
            leituras mensais. Ligue esta opção para ficar nesse teto.
          </span>
        </button>
        {value.inverterLimitKw != null && (
          <label className="label mt-4">
            Potência AC máxima do inversor (kW)
            <input
              type="number"
              min={1}
              max={20}
              step={0.1}
              className="field"
              value={value.inverterLimitKw}
              onChange={(e) => {
                const n = Number(e.target.value)
                patch({ inverterLimitKw: Number.isFinite(n) && n > 0 ? n : 4 })
              }}
            />
            <span className="meta">
              4 kW é o limiar habitual do regime simplificado. O estudo não escolhe um inversor acima deste valor.
            </span>
          </label>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-end justify-between">
          <h3 className="section-title">Consumo horário médio</h3>
          <span className="meta">{daily.toFixed(2)} kWh/dia · {(daily * 365).toFixed(0)} kWh/ano</span>
        </div>
        <div className="hour-bars">
          {value.hourlyKwh.map((kwh, i) => {
            const max = Math.max(...value.hourlyKwh, 0.2)
            return (
              <label key={i} className="hour-col">
                <span className="hour-val">{kwh >= 1 ? kwh.toFixed(2) : kwh.toFixed(3)}</span>
                <div className="hour-track">
                  <div className="hour-fill" style={{ height: `${(kwh / max) * 100}%` }} />
                </div>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={Number(kwh.toFixed(2))}
                  onChange={(e) => setHour(i, Number(e.target.value))}
                />
                <span className="hour-lbl">{String(i).padStart(2, '0')}h</span>
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}
