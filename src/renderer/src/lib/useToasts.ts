import { useCallback, useRef, useState } from 'react'

export type ToastKind = 'error' | 'info'

export interface Toast {
  id: string
  message: string
  kind: ToastKind
}

const AUTO_DISMISS_MS = 8000

export function useToasts(): {
  toasts: Toast[]
  pushToast: (message: string, kind?: ToastKind) => void
  dismissToast: (id: string) => void
} {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const pushToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = `toast-${nextId.current++}`
      setToasts((prev) => [...prev, { id, message, kind }])
      setTimeout(() => dismissToast(id), AUTO_DISMISS_MS)
    },
    [dismissToast]
  )

  return { toasts, pushToast, dismissToast }
}
