import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Nuntia',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        // Browser extensions rewrite the DOM before React hydrates. Grammarly
        // injects `data-gr-ext-installed` and `data-new-gr-c-s-check-loaded`
        // onto <body>, and React then reports attributes that were never in our
        // server-rendered HTML as a hydration mismatch.
        //
        // The suppression is deliberately narrow. React applies this flag to
        // this element's own attributes and its direct text nodes only — every
        // descendant is still checked, so a real mismatch anywhere in the app
        // tree is still reported. Our body holds only elements, so the text half
        // of the flag suppresses nothing at all.
        suppressHydrationWarning
      >
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
