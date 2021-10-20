import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import minimist from 'minimist'
import * as AtekNet from '@atek-cloud/network'
import { fromBase32 } from '@atek-cloud/network/dist/util.js'
import serve from 'serve-handler'
// @ts-ignore no definitions
import tx2 from 'tx2'
import { readKeyFile } from './lib/util.js'

const PUBLIC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

;(async () => {
  const args = minimist(process.argv)
  const port = args.port ? Number(args.port) : 2000
  const keyPair = await readKeyFile(args.keyfile)

  await AtekNet.setup()

  const node = new AtekNet.Node(keyPair)
  const agent = AtekNet.http.createAgent(node)

  const METRICS = {
    homeReqSec: tx2.meter({
      name: 'home req/seq',
      samples: 1,
      timeframe: 60
    }),
    gatewayReqSec: tx2.meter({
      name: 'gateway req/seq',
      samples: 1,
      timeframe: 60
    }),
    activeSockets: tx2.metric({
      name: 'active sockets',
      value: () => {
        return Array.from(node.sockets.values()).reduce((acc, arr) => acc + arr.length, 0)
      }
    })
  }


  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const hostparts = (req.headers.host || '').split('.')
    if (hostparts.length !== 3 || hostparts[1] !== 'atek' || hostparts[2] !== 'app') {
      METRICS.homeReqSec.mark()
      return serve(req, res, {
        public: PUBLIC_PATH,
        cleanUrls: true,
        directoryListing: false,
        trailingSlash: false,
        symlinks: false
      })
    }

    METRICS.gatewayReqSec.mark()

    const remotePublicKeyB32 = hostparts[0]
    try {
      fromBase32(remotePublicKeyB32)
    } catch (e: any) {
      return res.writeHead(404).end(`Subdomain is not a public key\n\n${e.toString()}`)
    }

    const headers = Object.assign({}, req.headers, {
      host: `${remotePublicKeyB32}.atek.app`
    })
    const proxyReq = http.request(`http://${remotePublicKeyB32}.atek.app${req.url}`, {
      agent,
      headers,
    }, (proxyRes: http.IncomingMessage) => {
      res.writeHead(proxyRes.statusCode || 0, proxyRes.statusMessage, proxyRes.headers)
      proxyRes.pipe(res)
    })
    req.pipe(proxyReq)
    proxyReq.on('error', (e: any) => {
      res.writeHead(500).end(`Failed to route request\n\n${e.toString()}`)
    })
  })
  server.listen(port)

  console.log(`Listening on localhost:${port}`)
})()