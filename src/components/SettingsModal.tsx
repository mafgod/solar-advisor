import { useEffect, useState } from 'react'
import type { Settings } from '../types'

interface Props {
  value: Settings
  onChange: (next: Settings) => void
  onClose: () => void
}

export function SettingsModal({ value, onChange, onClose }: Props) {
  const [googleOn, setGoogleOn] = useState<boolean | null>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) {
      setGoogleOn(false)
      return
    }
    void fetch('/api/gmaps/status')
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setGoogleOn(Boolean(d.enabled)))
      .catch(() => setGoogleOn(false))
  }, [])

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="settings-title">
        <div className="modal-head">
          <h2 id="settings-title">Definições</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
        <p className="hint">
          {googleOn
            ? 'A pesquisa de moradas usa o Google no servidor. A chave API não é enviada ao browser nem aparece aqui.'
            : 'Sem chave Google no servidor. A pesquisa de moradas usa OpenStreetMap. No GitHub Pages o Google não está disponível. Em local, defina GOOGLE_MAPS_API_KEY no .env da máquina (sem prefixo VITE_).'}
        </p>
        <p className="hint">As tags de afiliado ficam só neste browser e são opcionais.</p>
        <label className="label">
          Amazon Partner tag
          <input
            className="field"
            value={value.amazonTag}
            onChange={(e) => onChange({ ...value, amazonTag: e.target.value })}
            placeholder="minhaloja-21"
          />
        </label>
        <label className="label">
          AliExpress aff_short_key
          <input
            className="field"
            value={value.aliexpressAffKey}
            onChange={(e) => onChange({ ...value, aliexpressAffKey: e.target.value })}
          />
        </label>
        <button type="button" className="btn" onClick={onClose}>
          Guardar
        </button>
      </div>
    </div>
  )
}
