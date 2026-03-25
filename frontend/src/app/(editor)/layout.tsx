/*
 * SPDX-FileCopyrightText: 2023 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import '../../../global-styles/index.scss'
import { ApplicationLoader } from '../../components/application-loader/application-loader'
import { BaseUrlContextProvider } from '../../components/common/base-url/base-url-context-provider'
import { FrontendConfigContextProvider } from '../../components/common/frontend-config-context/frontend-config-context-provider'
import { DarkMode } from '../../components/layout/dark-mode/dark-mode'
import { ExpectedOriginBoundary } from '../../components/layout/expected-origin-boundary'
import { UiNotificationBoundary } from '../../components/notifications/ui-notification-boundary'
import { StoreProvider } from '../../redux/store-provider'
import { baseUrlFromEnvExtractor } from '../../utils/base-url-from-env-extractor'
import { configureLuxon } from '../../utils/configure-luxon'
import type { Metadata, Viewport } from 'next'
import type { PropsWithChildren } from 'react'
import React from 'react'
import { getConfig } from '../../api/config'
import { MotdProvider } from '../../components/motd/motd-context'
import { fetchMotd } from '../../components/global-dialogs/motd-modal/fetch-motd'
import { CachedMotdModal } from '../../components/global-dialogs/motd-modal/cached-motd-modal'

configureLuxon()

interface RootLayoutProps extends PropsWithChildren {
  appBar: React.ReactNode
}

export default async function RootLayout({ children, appBar }: RootLayoutProps) {
  const baseUrls = baseUrlFromEnvExtractor.extractBaseUrls()
  const frontendConfig = await getConfig(baseUrls.editor)
  const motd = await fetchMotd(baseUrls.internalApiUrl ?? baseUrls.editor)

  return (
    <html lang='en'>
      <head>
        <link color='#b51f08' href='/icons/safari-pinned-tab.svg' rel='mask-icon' />
        <script dangerouslySetInnerHTML={{__html: `
          // Get or create a Bearer token for the Braid public API.
          // Run in console: console.log(JSON.stringify(await get_api_token()))
          async function get_api_token() {
            var token = localStorage.getItem('hedgedoc-api-token')
            if (!token) {
              var csrf = await fetch('/api/private/csrf/token').then(r => r.json())
              var result = await fetch('/api/private/tokens', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'csrf-token': csrf.token},
                body: JSON.stringify({label: 'braid-editor', validUntil: '2027-01-01T00:00:00.000Z'})
              }).then(r => r.json())
              token = result.secret
              localStorage.setItem('hedgedoc-api-token', token)
            }
            return token
          }

          // Get the full Authorization header for external editors.
          // Run in console: console.log(JSON.stringify(await get_auth_header()))
          async function get_auth_header() {
            return {Authorization: 'Bearer ' + await get_api_token()}
          }
        `}} />
      </head>
      <body>
        <ExpectedOriginBoundary expectedOrigin={baseUrls.editor}>
          <BaseUrlContextProvider baseUrls={baseUrls}>
            <MotdProvider motd={motd}>
              <FrontendConfigContextProvider config={frontendConfig}>
                <StoreProvider>
                  <ApplicationLoader>
                    <DarkMode />
                    <CachedMotdModal />
                    <UiNotificationBoundary>
                      <div className={'d-flex flex-column vh-100'}>
                        {appBar}
                        {children}
                      </div>
                    </UiNotificationBoundary>
                  </ApplicationLoader>
                </StoreProvider>
              </FrontendConfigContextProvider>
            </MotdProvider>
          </BaseUrlContextProvider>
        </ExpectedOriginBoundary>
      </body>
    </html>
  )
}

export const metadata: Metadata = {
  applicationName: 'HedgeDoc',
  appleWebApp: {
    title: 'HedgeDoc'
  },
  description: 'HedgeDoc - Ideas grow better together',
  title: 'HedgeDoc',
  manifest: '/icons/site.webmanifest'
}

export const viewport: Viewport = {
  themeColor: '#b51f08',
  width: 'device-width',
  initialScale: 1
}
