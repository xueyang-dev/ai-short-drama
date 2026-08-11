'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ImageLightboxProps {
  src: string
  alt: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex h-[100dvh] w-screen cursor-zoom-out items-center justify-center bg-black/90 p-2 backdrop-blur-sm md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${alt}大图预览`}
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] cursor-default select-none object-contain shadow-2xl md:max-h-[calc(100dvh-2rem)] md:max-w-[calc(100vw-2rem)]"
        onClick={event => event.stopPropagation()}
      />
      <button
        type="button"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/65 text-white shadow-lg transition hover:border-white/50 hover:bg-black/85 md:right-6 md:top-6"
        aria-label="关闭大图预览"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
    </div>,
    document.body,
  )
}
