import { useEffect, useMemo, useRef, useState } from 'react'
import { ConsumptionForm } from './components/ConsumptionForm'
import { EvForm } from './components/EvForm'
import { GoalForm } from './components/GoalForm'
import { MapPicker } from './components/MapPicker'
import { Results } from './components/Results'
import { loadPvgis } from './lib/pvgis'
import { sizeSystem } from './lib/sizing'
import {
  loadResult,
  loadStudy,
  parseStudyFile,
  saveResult,
  saveStudy,
} from './lib/storage'
import { effectiveAzimuth } from './lib/geo'
import { clampEvChargePower } from './lib/ev'
import type { StudyInput, StudyResult } from './types'

const STEPS = [
  {
    id: 0,
    title: 'Localização',
    heading: 'Onde está a habitação?',
    lede: 'Encontre a casa no mapa. Depois toque em Desenhar e arraste sobre cada água do telhado. Use Tamanho para aumentar ou diminuir a zona.',
  },
  {
    id: 1,
    title: 'Consumo',
    heading: 'Como consome a casa?',
    lede: 'Importe o diagrama de carga e-redes ou ajuste o perfil horário. Pode limitar o inversor (ex.: 4 kW) para evitar contador de produção extra e SIM.',
  },
  {
    id: 2,
    title: 'Veículo elétrico',
    heading: 'Carregamento do VE',
    lede: 'Quilómetros ou kWh diários, potência do wallbox e horas em que realmente liga o carro.',
  },
  {
    id: 3,
    title: 'Objetivo',
    heading: 'O que pretende otimizar?',
    lede: 'Escolha inverno, verão, anual ou só standby. Pode ligar a previsão do clima e o anti-apagão.',
  },
  {
    id: 4,
    title: 'Estudo',
    heading: 'Pré-dimensionamento',
    lede: 'Valores indicativos com base no PVGIS, no telhado desenhado e no consumo declarado.',
  },
]

export default function App() {
  const [study, setStudy] = useState<StudyInput>(() => loadStudy())
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<StudyResult | null>(() => loadResult())
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    saveStudy(study)
  }, [study])

  useEffect(() => {
    saveResult(result)
  }, [result])

  useEffect(() => {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [step])

  const studyRun = useRef(0)

  const canNext = useMemo(() => {
    if (step === 0) return Number.isFinite(study.location.lat) && study.location.zones.length > 0
    if (step === 1) return study.consumption.hourlyKwh.reduce((a, b) => a + b, 0) > 0
    return true
  }, [step, study])

  const current = STEPS[step]

  function studyBlocker(input: StudyInput): string | null {
    if (!Number.isFinite(input.location.lat) || !Number.isFinite(input.location.lon)) {
      return 'Indique a localização da habitação.'
    }
    if (!input.location.zones.length) {
      return 'Marque pelo menos uma água do telhado no passo Localização.'
    }
    if (input.consumption.hourlyKwh.reduce((a, b) => a + b, 0) <= 0) {
      return 'Indique o consumo da casa no passo Consumo.'
    }
    return null
  }

  async function runStudy() {
    const id = ++studyRun.current
    setStep(4)
    const blocked = studyBlocker(study)
    if (blocked) {
      setError(blocked)
      setBusy(false)
      return
    }
    setBusy(true)
    setError('')
    try {
      const pvgis = await loadPvgis(
        study.location.lat,
        study.location.lon,
        study.location.roofTiltDeg,
        effectiveAzimuth(study.location),
        { useClimate: study.goal.useClimate },
      )
      if (id !== studyRun.current) return
      setResult(sizeSystem(study, pvgis))
    } catch (err) {
      if (id !== studyRun.current) return
      setError(err instanceof Error ? err.message : 'Falha no cálculo')
    } finally {
      if (id === studyRun.current) setBusy(false)
    }
  }

  function goToStep(next: number) {
    if (next === 4 && step !== 4) {
      void runStudy()
      return
    }
    setStep(next)
  }

  async function importStudy(file: File) {
    setError('')
    try {
      const parsed = parseStudyFile(await file.text())
      setStudy(parsed.input)
      setResult(parsed.result)
      setStep(parsed.result ? 4 : 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível abrir o estudo')
    }
  }

  return (
    <div className="app">
      <header className="masthead no-print">
        <div className="masthead-inner">
          <div className="brand">
            <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
              <rect width="64" height="64" rx="12" fill="#17355a" />
              <circle cx="46" cy="16" r="8" fill="#e8b86d" />
              <path d="M10 42 L32 22 L54 42 V56 H10 Z" fill="#f4f1ea" />
              <path d="M18 42 L32 29 L46 42" fill="none" stroke="#0f2744" strokeWidth="1.6" />
              <rect x="28" y="42" width="8" height="14" fill="#0f2744" />
              <rect x="16" y="44" width="10" height="7" fill="#c9d6e3" />
              <rect x="38" y="44" width="10" height="7" fill="#c9d6e3" />
            </svg>
            <div>
              <strong className="brand-name">CasaSolar</strong>
              <span className="brand-sub">Estudo de autoconsumo</span>
            </div>
          </div>
          <div className="mast-actions">
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importStudy(file)
              }}
            />
            <button type="button" className="btn-ghost" onClick={() => importRef.current?.click()}>
              Abrir estudo
            </button>
          </div>
        </div>
      </header>

      <div className="page">
        <ol className="stepper no-print" aria-label="Passos do estudo">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={step === s.id ? 'step on' : step > s.id ? 'step done' : 'step'}
                onClick={() => goToStep(s.id)}
              >
                <span className="step-num">{s.id + 1}</span>
                <span className="step-label">{s.title}</span>
              </button>
              {i < STEPS.length - 1 && <span className={step > s.id ? 'step-line done' : 'step-line'} />}
            </li>
          ))}
        </ol>

        <main className="panel">
          {current && (
            <header className="panel-head">
              <p className="kicker">
                Passo {step + 1} de {STEPS.length} · {current.title}
              </p>
              <h2>{current.heading}</h2>
              <p className="lede">
                {step === 4 && study.goal.useClimate
                  ? 'Valores indicativos com base no PVGIS, no clima típico do local (sobretudo o inverno nublado), no telhado desenhado e no consumo declarado.'
                  : current.lede}
              </p>
            </header>
          )}

          <div className={step === 0 ? undefined : 'hidden'} inert={step !== 0}>
            <MapPicker
              value={study.location}
              active={step === 0}
              onChange={(location) => setStudy({ ...study, location })}
            />
          </div>
          {step === 1 && (
            <ConsumptionForm
              value={study.consumption}
              onChange={(consumption) =>
                setStudy({
                  ...study,
                  consumption,
                  ev: {
                    ...study.ev,
                    chargePowerKw: clampEvChargePower(study.ev.chargePowerKw, consumption.phase),
                  },
                })
              }
            />
          )}
          {step === 2 && (
            <EvForm
              value={study.ev}
              phase={study.consumption.phase}
              onChange={(ev) => setStudy({ ...study, ev })}
            />
          )}
          {step === 3 && <GoalForm value={study.goal} onChange={(goal) => setStudy({ ...study, goal })} />}
          {step === 4 && busy && (
            <div className="empty">
              <p>
                {study.goal.useClimate
                  ? 'A consultar o clima e o PVGIS com os valores actuais…'
                  : 'A consultar o PVGIS com os valores actuais…'}
              </p>
            </div>
          )}
          {step === 4 && !busy && result && <Results input={study} result={result} />}
          {step === 4 && !busy && !result && (
            <div className="empty">
              <p>
                Ainda não há estudo. Marque o telhado, confirme o consumo (ou use o perfil pré-preenchido) e volte a
                este passo — o cálculo usa os valores já escolhidos nos restantes passos.
              </p>
              <button type="button" className="btn-ghost" onClick={() => importRef.current?.click()}>
                Abrir estudo
              </button>
            </div>
          )}
          {error && <p className="err">{error}</p>}

          <div className="panel-nav no-print">
            <button type="button" className="btn-ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
              Anterior
            </button>
            {step < 3 && (
              <button type="button" className="btn" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                Continuar
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn" disabled={busy} onClick={() => void runStudy()}>
                {busy
                  ? study.goal.useClimate
                    ? 'A consultar o clima e o PVGIS…'
                    : 'A consultar o PVGIS…'
                  : 'Calcular estudo'}
              </button>
            )}
            {step === 4 && (
              <button type="button" className="btn" disabled={busy} onClick={() => void runStudy()}>
                Recalcular
              </button>
            )}
          </div>
        </main>

        <p className="legal no-print">
          Ferramenta de pré-dimensionamento para autoconsumo residencial. Os resultados são indicativos e não
          substituem projeto certificado, visita técnica nem o cumprimento da regulamentação aplicável.
          <span className="legal-contact">
            Informações ou sugestões:{' '}
            <a href="mailto:mafgod@hotmail.com">mafgod@hotmail.com</a>
          </span>
        </p>
      </div>
    </div>
  )
}
