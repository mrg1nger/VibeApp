import { useId } from 'react'

export const ORG_NAME = 'RedAstra Labs'
export const ORG_URL = 'https://redastralabs.com'
export const REPO_URL = 'https://github.com/mrg1nger/VibeApp'
export const LICENSE_URL = `${REPO_URL}/blob/master/LICENSE`

/** RedAstra Labs' star-and-orbit mark, as on redastralabs.com. */
export function LogoMark({ size = 18 }: { size?: number }) {
  const id = useId()
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff7a63" />
          <stop offset="1" stopColor="#c0311a" />
        </linearGradient>
      </defs>
      <ellipse
        cx="16"
        cy="16"
        rx="12.5"
        ry="5"
        transform="rotate(-20 16 16)"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="1.1"
        opacity="0.65"
      />
      <path d="M16 6.5 L18.2 14 L26 16 L18.2 18 L16 25.5 L13.8 18 L6 16 L13.8 14 Z" fill={`url(#${id})`} />
    </svg>
  )
}

/** The small org line over the VibeApp title. */
export function BrandTitle() {
  return (
    <div className="brand-title">
      <a className="brand-org" href={ORG_URL} target="_blank" rel="noreferrer" title={ORG_URL}>
        <LogoMark size={13} />
        {ORG_NAME}
      </a>
      <h1>VibeApp</h1>
    </div>
  )
}

const GlobeIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
  </svg>
)

const RepoIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
)

const LicenseIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z" />
  </svg>
)

/** Org, website, source and licence along the bottom of every screen. */
export function AppFooter() {
  return (
    <footer className="app-footer">
      <span className="app-footer-org">
        <LogoMark size={12} />
        VibeApp {__APP_VERSION__} by {ORG_NAME}
      </span>
      <a href={ORG_URL} target="_blank" rel="noreferrer">
        <GlobeIcon />
        redastralabs.com
      </a>
      <a href={REPO_URL} target="_blank" rel="noreferrer">
        <RepoIcon />
        GitHub
      </a>
      <a href={LICENSE_URL} target="_blank" rel="noreferrer">
        <LicenseIcon />
        MIT License
      </a>
    </footer>
  )
}
