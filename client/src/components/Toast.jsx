// client/src/components/Toast.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Lightweight toast notification system.
//
//  Usage:
//    const { addToast } = useToast();
//    addToast('Player connected', 'success');
//    addToast('Player disconnected', 'warning');
//    addToast('Player removed', 'info');
//
//  Toast types: 'success' | 'warning' | 'info' | 'error'
//  Each toast auto-dismisses after TOAST_DURATION_MS.
//
//  ToastContainer renders all active toasts and should be placed once
//  inside each page component (or a shared layout if you add one later).
//
//  useToast() is a standalone hook — no context provider needed.
//  Call it inside any component; each call gets its own independent queue.
//  For a shared queue across a page's sub-components, lift the hook call
//  to the page level and pass addToast down as a prop.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef } from 'react';

const TOAST_DURATION_MS = 4000;

// ─────────────────────────────────────────────
//  Hook
// ─────────────────────────────────────────────

/**
 * Returns { toasts, addToast }.
 *
 * @returns {{ toasts: Toast[], addToast: (message: string, type?: string) => void }}
 */
export function useToast() {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const addToast = useCallback((message, type = 'info') => {
    const id = ++counterRef.current;
    setToasts(prev => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return { toasts, addToast };
}

// ─────────────────────────────────────────────
//  Toast item
// ─────────────────────────────────────────────

const TYPE_CONFIG = {
  success: { icon: '✓', className: 'toast--success' },
  warning: { icon: '⚠',  className: 'toast--warning' },
  info:    { icon: 'ℹ',  className: 'toast--info'    },
  error:   { icon: '✕',  className: 'toast--error'   },
};

function ToastItem({ toast, onDismiss }) {
  const cfg = TYPE_CONFIG[toast.type] || TYPE_CONFIG.info;

  return (
    <div
      className={`toast ${cfg.className}`}
      role="status"
      aria-live="polite"
      onClick={() => onDismiss(toast.id)}
    >
      <span className="toast__icon" aria-hidden="true">{cfg.icon}</span>
      <span className="toast__message">{toast.message}</span>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Container — render inside your page component
// ─────────────────────────────────────────────

/**
 * @param {{ toasts: Toast[], onDismiss: (id: number) => void }} props
 */
export function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;

  return (
    <div className="toast-container" aria-label="Notifications">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}