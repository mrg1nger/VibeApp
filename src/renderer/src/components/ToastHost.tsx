import type { Toast } from '../lib/useToasts'

interface ToastHostProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  if (toasts.length === 0) return null

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.message}</span>
          <button onClick={() => onDismiss(toast.id)}>&times;</button>
        </div>
      ))}
    </div>
  )
}

export default ToastHost
