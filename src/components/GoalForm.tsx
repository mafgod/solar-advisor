import { clampBackupHours, formatBackupDuration, MAX_BACKUP_HOURS } from '../lib/defaults'
import type { GoalInput, GoalMode } from '../types'

const BACKUP_PRESETS = [
  { hours: 8, label: '8 h' },
  { hours: 24, label: '1 dia' },
  { hours: 48, label: '2 dias' },
  { hours: 72, label: '3 dias' },
  { hours: 168, label: '7 dias' },
]

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
            <span className="mode-title">Anti-apagão (standby)</span>
            <span>
              Com rede, o inversor fica em grid-tie em paralelo com a instalação. Sem rede, o ATS comuta o quadro geral
              para a saída EPS/backup. A autonomia calcula-se só com o standby (router, alarme, cargas em espera).
            </span>
          </button>
        </div>
      </div>

      {value.antiBlackout && (
        <div className="card space-y-4">
          <h3 className="section-title">Autonomia da casa em falha de rede</h3>
          <p className="hint">
            Bateria e PV extra usam o standby declarado no passo Consumo, não o consumo médio da casa. A bateria cobre
            a duração escolhida; o FV extra recupera cerca de um dia de standby. O ATS comuta o quadro geral: em
            ilhamento não carregue o VE nem ligue o resto das cargas.
          </p>
          <div className="flex flex-wrap gap-2">
            {BACKUP_PRESETS.map((p) => (
              <button
                key={p.hours}
                type="button"
                className={value.backupHours === p.hours ? 'chip on' : 'chip'}
                onClick={() => patch({ backupHours: p.hours })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="label">
            Duração da falha de rede
            <input
              type="range"
              min={1}
              max={MAX_BACKUP_HOURS}
              value={value.backupHours}
              onChange={(e) => patch({ backupHours: clampBackupHours(Number(e.target.value)) })}
            />
            <span className="meta">
              {formatBackupDuration(value.backupHours)} só com standby no EPS
            </span>
          </label>
        </div>
      )}
    </div>
  )
}
