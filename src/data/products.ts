import type { Product, StudyResult } from '../types'

function pickInverterModel(kw: number, three: boolean): { brand: string; model: string; search: string } {
  if (three) {
    if (kw <= 8) return { brand: 'Deye', model: 'SUN-8K-SG04LP3', search: 'Deye hybrid inverter 8kW three phase' }
    if (kw <= 12) return { brand: 'Deye', model: 'SUN-12K-SG04LP3', search: 'Deye hybrid inverter 12kW three phase' }
    return { brand: 'Deye', model: 'SUN-15K-SG01HP3', search: 'Deye hybrid inverter 15kW three phase' }
  }
  if (kw <= 3.6) return { brand: 'Deye', model: 'SUN-3.6K-SG03LP1-EU', search: 'Deye SUN-3.6K-SG03LP1 hybrid inverter' }
  if (kw <= 6) return { brand: 'Deye', model: 'SUN-6K-SG03LP1-EU', search: 'Deye SUN-6K-SG03LP1 hybrid inverter' }
  if (kw <= 8) return { brand: 'Deye', model: 'SUN-8K-SG05LP1-EU', search: 'Deye SUN-8K hybrid inverter single phase' }
  return { brand: 'Deye', model: 'SUN-10K-SG02LP1-EU', search: 'Deye SUN-10K hybrid inverter single phase' }
}

function pickBattery(kwh: number): { brand: string; model: string; search: string; spec: string; qty: number } {
  if (kwh <= 5.5) {
    return {
      brand: 'Pylontech',
      model: 'US5000',
      search: 'Pylontech US5000 4.8kWh 48V LiFePO4',
      spec: '4,8 kWh LFP 48 V',
      qty: 1,
    }
  }
  if (kwh <= 10.5) {
    return {
      brand: 'Pylontech',
      model: 'US5000 ×2',
      search: 'Pylontech US5000 4.8kWh 48V LiFePO4',
      spec: '2×4,8 kWh LFP 48 V',
      qty: 2,
    }
  }
  if (kwh <= 16) {
    return {
      brand: 'Seplos / EVE',
      model: 'Mason 280 Ah',
      search: 'Seplos Mason 280Ah 48V LiFePO4 14kWh',
      spec: '~14 kWh LFP 51,2 V',
      qty: 1,
    }
  }
  const n = Math.ceil(kwh / 14)
  return {
    brand: 'Seplos / EVE',
    model: `Mason 280 Ah ×${n}`,
    search: 'Seplos Mason 280Ah 48V LiFePO4 14kWh',
    spec: `${n}× ~14 kWh LFP`,
    qty: n,
  }
}

export function recommendProducts(result: StudyResult): Product[] {
  const inv = pickInverterModel(result.inverterKw, result.inverterPhase === 'three')
  const bat = pickBattery(result.batteryKwh)
  const items: Product[] = [
    {
      id: 'pv',
      category: 'painel',
      brand: 'Jinko / Longi / Trina',
      model: `Módulo ~${result.panelWatts} W`,
      spec: `${result.panelCount} módulos, ${result.pvKwp.toFixed(2)} kWp`,
      why: 'Módulos N-type de 430–460 W são o compromisso habitual entre preço, área e garantia de 25–30 anos.',
      search: `painel solar ${result.panelWatts}W N-type mono`,
      qty: result.panelCount,
    },
    {
      id: 'inv',
      category: 'inversor',
      brand: inv.brand,
      model: inv.model,
      spec: `${result.inverterKw} kW híbrido ${result.inverterPhase === 'three' ? 'trifásico' : 'monofásico'}`,
      why:
        result.inverterPhase === 'three'
          ? 'Híbrido trifásico de baixa tensão (48 V) com EPS/backup, para ramal a 400 V.'
          : 'Híbrido monofásico 230 V (48 V no lado da bateria) com EPS/backup. Adequado ao ramal monofásico da casa — não use um trifásico neste quadro.',
      search: inv.search,
    },
    {
      id: 'bat',
      category: 'bateria',
      brand: bat.brand,
      model: bat.model,
      spec: bat.spec,
      why: 'Química LFP, DoD ~90 % e ciclo diário. Pylontech para plug-and-play; Seplos/EVE para €/kWh mais baixo.',
      search: bat.search,
      qty: bat.qty,
    },
  ]

  if (result.atsRequired) {
    items.push({
      id: 'ats',
      category: 'ats',
      brand: 'Chint / TOQ7',
      model: result.inverterPhase === 'three' ? 'ATS 4P 63 A' : 'ATS 2P 63 A',
      spec: 'Comutação rede ↔ EPS',
      why: 'O ATS isola a rede em falha e liga o quadro geral à saída de backup do inversor, para a casa toda. Com rede, o inversor permanece em grid-tie em paralelo.',
      search:
        result.inverterPhase === 'three'
          ? 'automatic transfer switch 4P 63A ATS'
          : 'TOQ7-63/2P automatic transfer switch ATS',
    })
  }

  items.push(
    {
      id: 'dc-iso',
      category: 'protecao',
      brand: 'Noark / Chint',
      model: 'Seccionador DC 32 A 1000 V',
      spec: '2P (ou 4P se 2 strings)',
      why: 'Corte visível do lado DC, junto ao inversor, conforme boa prática RTIEBT.',
      search: 'DC isolator switch 32A 1000V 4P solar',
    },
    {
      id: 'spd-dc',
      category: 'protecao',
      brand: 'Citiel / Phoenix',
      model: 'SPD Tipo 2 DC',
      spec: '1000 Vcc, 20 kA',
      why: 'Descarregador de sobretensões no quadro DC, com fusíveis gPV a montante das strings.',
      search: 'SPD type 2 DC 1000V solar surge protector',
    },
    {
      id: 'rcbo',
      category: 'protecao',
      brand: 'Schneider / ABB',
      model: 'Diferencial Tipo B + disjuntor',
      spec: '30 mA Tipo B, curva C',
      why: 'Inversores híbridos com EPS devem usar diferencial Tipo B (ou A-SI segundo o fabricante) no lado AC.',
      search: 'RCCB type B 30mA 40A solar inverter',
    },
    {
      id: 'spd-ac',
      category: 'protecao',
      brand: 'Schneider / Chint',
      model: 'SPD Tipo 2 AC',
      spec: result.inverterPhase === 'three' ? 'T2 20 kA 4P' : 'T2 20 kA 2P',
      why: 'Proteção de sobretensão no quadro geral / quadro do inversor, lado AC e junto ao ATS.',
      search: 'SPD type 2 AC 20kA 2P surge protector',
    },
  )

  return items
}
