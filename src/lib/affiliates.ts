import type { Product } from '../types'

export function amazonUrl(query: string, tag: string): string {
  const u = new URL('https://www.amazon.es/s')
  u.searchParams.set('k', query)
  if (tag.trim()) u.searchParams.set('tag', tag.trim())
  return u.toString()
}

export function aliexpressUrl(query: string, affKey: string): string {
  const target = new URL('https://pt.aliexpress.com/w/wholesale.html')
  target.searchParams.set('SearchText', query)
  if (!affKey.trim()) return target.toString()
  const deep = new URL('https://s.click.aliexpress.com/deep_link.htm')
  deep.searchParams.set('aff_short_key', affKey.trim())
  deep.searchParams.set('dl_target_url', target.toString())
  return deep.toString()
}

export function withLinks(
  products: Product[],
  amazonTag: string,
  aliKey: string,
): (Product & { amazon: string; aliexpress: string })[] {
  return products.map((p) => ({
    ...p,
    amazon: amazonUrl(p.search, amazonTag),
    aliexpress: aliexpressUrl(p.search, aliKey),
  }))
}
