import { useEffect, useState } from 'react'

/** The width (in CSS pixels) below which VibeApp uses its phone layout; matches styles.css. */
export const PHONE_QUERY = '(max-width: 760px)'

/** True on a phone-sized screen (VibeApp opened in a phone's browser through Remote access). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY)
    const update = (): void => setPhone(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}
