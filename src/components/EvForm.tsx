import { useEffect } from 'react'
import { clampEvChargePower, evChargeOptions } from '../lib/ev'
import type { EvInput, PhaseType } from '../types'

interface Props {
  value: EvInput
  phase: PhaseType
  onChange: (next: EvInput) => void
}

export function EvForm({ value, phase, onChange }: Props) {
  const hoursOn = value.chargeHours.filter(Boolean).length
  const energy =
    value.dailyKwhOverride && value.dailyKwhOverride > 0
      ? value.dailyKwhOverride
      : (value.dailyKm * value.kwhPer100km) / 100

  function patch(partial: Partial<EvInput>) {
    onChange({ ...value, ...partial })
  }

  function toggleHour(i: number) {
    const chargeHours = [...value.chargeHours]
    chargeHours[i] = !chargeHours[i]
    patch({ chargeHours })
  }

  const chargeOptions = evChargeOptions(phase)
  const chargePowerKw = clampEvChargePower(value.chargePowerKw, phase)

  useEffect(() => {
    if (chargePowerKw !== value.chargePowerKw) {
      patch({ chargePowerKw })
    }
  }, [chargePowerKw, value.chargePowerKw])

  return (
    <div className="space-y-6">
      <label className="check">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        Há veículo elétrico nesta habitação
      </label>

      <fieldset disabled={!value.enabled} className="space-y-5 disabled:opacity-50">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="label">
            Quilómetros por dia
            <input
              type="number"
              min={0}
              className="field"
              value={value.dailyKm}
              onChange={(e) => patch({ dailyKm: Number(e.target.value) })}
            />
          </label>
          <label className="label">
            Consumo do VE (kWh/100 km)
            <input
              type="number"
              min={10}
              step={0.5}
              className="field"
              value={value.kwhPer100km}
              onChange={(e) => patch({ kwhPer100km: Number(e.target.value) })}
            />
          </label>
          <label className="label">
            Energia diária (kWh) — opcional
            <input
              type="number"
              min={0}
              step={0.5}
              className="field"
              placeholder="calculado pelos km"
              value={value.dailyKwhOverride ?? ''}
              onChange={(e) =>
                patch({
                  dailyKwhOverride: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label className="label">
            Potência de carregamento (kW)
            <select
              className="field"
              value={chargePowerKw}
              onChange={(e) => patch({ chargePowerKw: Number(e.target.value) })}
            >
              {chargeOptions.map((o) => (
                <option key={o.kw} value={o.kw}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="meta">
              {phase === 'three'
                ? 'Ramal trifásico: pode escolher wallbox 11 ou 22 kW.'
                : 'Ramal monofásico: só Schuko ou wallbox 230 V (até 7,4 kW).'}
            </span>
          </label>
        </div>

        <div>
          <div className="mb-2 flex justify-between">
            <h3 className="section-title">Janela de carregamento</h3>
            <span className="meta">
              {energy.toFixed(1)} kWh/dia · {hoursOn} h selecionadas
            </span>
          </div>
          <div className="hour-picks">
            {value.chargeHours.map((on, i) => (
              <button
                key={i}
                type="button"
                className={on ? 'pick on' : 'pick'}
                onClick={() => toggleHour(i)}
              >
                {String(i).padStart(2, '0')}
              </button>
            ))}
          </div>
          <p className="hint mt-3">
            Horário de vazio típico em Portugal continental: 22:00–08:00 (ou 00:00–08:00 no ciclo diário). Se carregar
            de dia, o estudo tenta cobrir essa energia com FV.
          </p>
        </div>
      </fieldset>
    </div>
  )
}
