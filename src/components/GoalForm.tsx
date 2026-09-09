import type { GoalInput, GoalMode } from '../types'

const MODES: { id: GoalMode; title: string; text: string }[] = [
  {
    id: 'winter',
    title: 'Otimização para o inverno',
    text: 'Mais kWp para aguentar dezembro/janeiro. No verão sobra energia para exportar ou para o VE.',
  },
  {
    id: 'summer',
    title: 'Otimização para o verão',
    text: 'Campo FV mais contido, pensado em ar condicionado e autoconsumo estival, sem oversizing de inverno.',
  },
  {
    id: 'annual',
    title: 'Otimização anual',
    text: 'Equilíbrio clássico: cobrir a maior parte do consumo anual com bom autoconsumo e bateria de ciclo diário.',
  },
  {
    id: 'standby',
    title: 'Apenas eliminar o standby',
    text: 'Kit pequeno para as cargas fantasma (router, alarme, em espera). Não alimenta a casa completa.',
  },
]

interface Props {
  value: GoalInput
  onChange: (next: GoalInput) => void
}

export function GoalForm({ value, onChange }: Props) {
  function patch(partial: Partial<GoalInput>) {
    onChange({ ...value, ...partial })
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="meta mb-2">Objetivo energético (escolha um)</p>
        <div className="grid gap-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={value.mode === m.id ? 'mode on' : 'mode'}
              onClick={() => patch({ mode: m.id })}
            >
              <span className="mode-title">{m.title}</span>
              <span>{m.text}</span>
            </button>
          ))}
        </div>
      </div>

      {value.mode === 'annual' && (
        <label className="label">
          Fração do consumo anual a cobrir com FV
          <input
            type="range"
            min={50}
            max={120}
            value={Math.round(value.annualCoverage * 100)}
            onChange={(e) => patch({ annualCoverage: Number(e.target.value) / 100 })}
          />
          <span className="meta">{Math.round(value.annualCoverage * 100)} %</span>
        </label>
      )}

      <div>
        <p className="meta mb-2">Pode combinar com qualquer objetivo acima</p>
        <div className="grid gap-3">
          <button
            type="button"
            className={value.useClimate ? 'mode on' : 'mode'}
            onClick={() => patch({ useClimate: !value.useClimate })}
          >
            <span className="mode-title">Previsão do clima</span>
            <span>
              Usa o tempo habitual deste local (PVGIS), sobretudo o inverno nublado, as sequências de chuva e a
              bateria no frio. Sem isto, o cálculo fica só com a produção média mensal.
            </span>
          </button>
          <button
            type="button"
            className={value.antiBlackout ? 'mode on' : 'mode'}
            onClick={() => patch({ antiBlackout: !value.antiBlackout })}
          >
            <span className="mode-title">Anti-apagão (casa toda)</span>
            <span>
              Com rede, o inversor fica em grid-tie em paralelo com a instalação. Sem rede, o ATS comuta o quadro geral
              para a saída EPS/backup e a casa toda fica nessa saída.
            </span>
          </button>
        </div>
      </div>

      {value.antiBlackout && (
        <div className="card space-y-4">
          <h3 className="section-title">Autonomia da casa em falha de rede</h3>
          <p className="hint">
            A potência média e o pico vêm do consumo declarado (passo anterior), sem o VE. Em ilhamento, evite o
            wallbox.
          </p>
          <label className="label">
            Horas de anti-apagão
            <input
              type="range"
              min={1}
              max={24}
              value={value.backupHours}
              onChange={(e) => patch({ backupHours: Number(e.target.value) })}
            />
            <span className="meta">
              {value.backupHours} h com a casa toda no EPS (consumo médio declarado)
            </span>
          </label>
        </div>
      )}
    </div>
  )
}
