import { describe, it, expect } from 'vitest'
import { SERVICES, uptimeScopeOf } from '../services'
import type { ServiceConfig } from '../types'

// #1679 — what each service's uptime30d is computed over, pinned per service. #992 dropped Cerebras's
// `statusComponentIds` to fix its breakdown, and the Atlassian uptime scope silently collapsed to the
// Developer Console because the scope is derived from badge fields. A config edit that changes any
// service's uptime scope now fails here, and the snapshot has to be updated on purpose.
//
// The descriptor follows the branch order `fetchService` uses to pick an uptime source. Only the config
// side is pinnable: BetterStack and Datadog scopes are read from the live page.
function uptimeScopeDescriptor(s: ServiceConfig): string {
  if (s.rootlyFeed) return `rootly ${(s.displayComponentIds ?? ['all chart components']).join(',')}`
  if (s.flashdutyFeed) {
    const primary = `flashduty ${[s.flashdutyPrimaryComponentId ?? 'all components'].flat().join(',')}`
    const fallback = s.apiUrl ? uptimeScopeOf(s) : []
    return fallback.length ? `${primary} | atlassian ${fallback.join(',')}` : primary
  }
  if (s.cloudflareStatusComponentIds) return 'none'
  if (s.datadogStatusUrl) return `datadog group ${s.datadogComponentGroupId}`
  if (s.apiUrl) {
    if (s.incidentIoComponentId) return `incident.io ${[s.statusComponentIds ?? s.incidentIoComponentId].flat().join(',')}`
    if (s.uptimeOverLiveComponents) return 'atlassian live components'
    const atlassian = uptimeScopeOf(s)
    return atlassian.length ? `atlassian ${atlassian.join(',')}` : 'none'
  }
  if (s.awsHealthApi || s.azureRssUrl) return 'none'
  if (s.betterStackUrl) return 'betterstack all page resources'
  if (s.instatusUrl && s.statusComponent) return `instatus name ${s.statusComponent}`
  return 'none'
}

describe('#1679 — every service\'s uptime scope is pinned', () => {
  it('matches the snapshot', () => {
    expect(Object.fromEntries(SERVICES.map((s) => [s.id, uptimeScopeDescriptor(s)]))).toMatchInlineSnapshot(`
      {
        "assemblyai": "atlassian 50txf4qfk2kv",
        "azureopenai": "none",
        "bedrock": "none",
        "bfl": "atlassian ws9rrzk6n2j7,m991l9z7y6jj",
        "cerebras": "atlassian live components",
        "characterai": "atlassian fw8g76r7dqcl",
        "chatgpt": "incident.io 01JMXBNJXGV1T5GT2M9XA83XNG,01JMXBNJXGKKP51D4DEJ2HZJ8Q,01JMXBNJXGGT5SR5DB9J7GYY48,01JSFK5QX36ZRW0TW0ZV0ZYFXQ,01JSYVYQSWMJ9QG35XHP08BHA7,01K6TVGGGDCP0PPGCHXAG3AQX8,01JQ7EKW990MSPSWVXC7VPV2ZJ,01JMXBNJXG1S2D9V65P1ZZTD94,01JMXBNJXG1YMQPPCPCQX3MPA2,01JSG1XMJ9RVJJQ0E85NVSJ2AZ,01KMKFAMWKQ81YWSE1Z18R6VHR,01JNKS9D9S72PMP1938PVFFQN4,01KX45G1SHQQ9DTAX9S4W7FV8G,01KX45G1SH21AX5DT93D4HMF0P,01M3Q6NERHVE2WPPAQRHBAC6XB,01M3Q6NERHS4BG0HQ85VAR1SRH",
        "claude": "atlassian k8w3r06qmzrp",
        "claudeai": "atlassian rwppv331jlwc,bpp5gb3hpjcl",
        "claudecode": "atlassian yyzkbfz2thpt",
        "codex": "incident.io 01KMP3KP5MGE23B80K1EK4S8PV,01KMKFAMWKNQ84Z1766MV08ZDE,01KMP3KP5M8X0EBTVW6KN327EE,01JVCV8YSWZFRSM1G5CVP253SK",
        "cohere": "incident.io 01HQ6CA39NZ5X3PRFPN71Q89TE",
        "copilot": "atlassian pjmpxvq2cmr2,cnnb39dkkk82",
        "cursor": "atlassian rflc60xp5jp2,mwv1g9sc7kdh,k0trcq273dr6,vsny1qv7v86c,2x2chyqwmkzl",
        "deepgram": "atlassian cv8l6gg3cb9d",
        "deepseek": "flashduty 01KY4MVS8BM3F9JSYWACGQVG7A,01KY4MVS8BSBSVW6053QJ37RJE | atlassian j4n367d9mh3x",
        "deepseekapp": "flashduty 01KY4ND2PNYT9FY5W4ZH80VGJ4,01KY4ND2PN1CCNW2MFT5VW713H,01KY4ND2PNJ6MFA4VJ0DSN6M2J,01KY4ND2PNNFFY6QKV67WFJW8N,01KY4ND2PN6EFSJ4RDYDJYPMNK",
        "elevenlabs": "incident.io 01JP2RQVGDHPEEDAFM5KV2MH9P,01JYDTNNSJBT4X90MAC47YPM9S,01JY3H5SJJZNC33AYMAE4SK4TH,01JY3H5SJJD2BMSGSW5FZE08ST,01JY3H5SJJJG47J60JPKX882H8,01JY3H5SJJFKTXYQHG5A8Z1KYH,01JJM5RKYAEWNM3XYRHXM8FJQ3",
        "fal": "instatus name API",
        "fireworks": "incident.io 01KTM9PHXTQ0YX1ZM3TRVACTK8,01KVEMZE3M15ZV46ZEB7X88H61,01KYQSPPP8VB3N85P4Y2A01RSR,01KYQSPPP80JDA3M7X73DNKHHD,01KYQT4MDWSVEMPWCVPC90ZSA8,01M03TGQ7XTQ8HAKZ8MDQ44HH5,01M0VEYRP3Q4KM0RDEFG6EBBZC,01M0VEYRP3YY99KM87D9CNZ7MG,01M1DFY7G1ZJQNNZWX0Y0APVX6,01M1DFY7G1JXWQQQ852G0PAQCP,01M29PF3FR517GWQBY4BHZMV8A",
        "fishaudio": "betterstack all page resources",
        "gemini": "none",
        "grok": "none",
        "groq": "incident.io 01K053E2FAKWKEYHXEV7WAHJBM",
        "helicone": "betterstack all page resources",
        "huggingface": "betterstack all page resources",
        "jina": "atlassian fc5zn3rkh5bd,v6lh7spvvvf5,7b9xrr2ksh44,67hcttb83zzv,skb1snhyjd6h,phbgjfg719q6,d52c7tz1hnpd,b2tt4jb1x7pz,d7nnpf4sr394,dwcjc0rgg6hn,cm0h2r8mw593,3f6qdtwq4yv6,lbtxhdqvr205,yxvtk6kpvycp,895s37lq7d5q",
        "junie": "incident.io 01KX3EN535A0SKSZK3S84949V1",
        "kimi": "atlassian 8psr5dfdld0s",
        "langfuse": "incident.io 01KS5BHY7AKJD8YEM4MFYMB35Z,01KS5BHY7AX99XYA7AS7AAP7QG,01KS5BHY7AH52EZHZQ9TYD53TY",
        "langsmith": "incident.io 01KX6FV0RR5XXJ0SM3NXZRKMBY,01KX6FV0RRSSTKC5V2GPAMCEQR,01KX6FV0RRKA56PXCRWEHJTMXM",
        "luma": "betterstack all page resources",
        "mistral": "rootly 304d5895-4dde-47be-b2e1-b7ebeb28dd4d,719fdf28-3a3d-48f9-bfe3-7766e55091b4,ba3a6e31-16e8-48c1-9a0e-dc09d9f65b68,a4b27297-cd30-47b8-8ac0-1d1081fe905a,4b32fcf7-6173-4456-85ba-048d384ae4a6,74350cee-8e18-44bb-be49-9a5ae3f8f218,951414e5-fcd1-4c1d-9f2f-acaf726bd245,3e804d64-e876-488f-ba91-69913a2d54f9,7ea6517b-2d19-42f8-b90f-39607552a60b,d16850a6-af05-4366-abc2-65d89959305d,3abd6dd4-8de0-44ad-a65c-e11280a66ca9,2b40e771-7a56-40b3-8e96-792740c301f4,974aefe0-ee25-48a2-ac3d-4f12cc788c2d",
        "modal": "betterstack all page resources",
        "openai": "incident.io 01JMXBRMFE6N2NNT7DG6XZQ6PW,01JP8CD9JR3HR6Y7G4Q75N4DVW,01JMXBRMFEMZK0HPK19RYET250,01JMXBRMFEV0AJ0VVS68N9CD6R,01JMXBRMFE4MAP2BHSJNZ787WX,01JMXBRMFE5ESNNV8JDHVCGSRD,01JMXBRMFEKVBWKK82B44QFMCE,01JMXBRMFEVZ7E0X9GD9FWR9WX,01JMXBRMFEQW613TFE89F45035,01JMXBRMFESJCBGJR10PDD3WCQ,01JSM5RTJWHRWDTS6Q604VEW3B,01M3Q6W0264T1RJS1YEM47CAQJ,01M3Q6W0262E8VW5DE1MJMMN0T",
        "openrouter": "datadog group 62d944d3-1acb-471b-81a0-099b3da0164f",
        "perplexity": "incident.io 01KZSFD424NN3EYBS78TMVWNEK,01KZSFD424KQ6VQYV4R0KCA30P,01M0TRMC3ED1PG4GRRXXMVNNZ6,01M2R6E5FPASTEW3A3V8TSYHJ0",
        "pinecone": "atlassian r7tngp2p3sjd",
        "replicate": "none",
        "runway": "atlassian w3jcq3dwljp4,2fr8tksxj5ns,hl94rh0mg6xt",
        "stability": "incident.io 01JW9J39X55NDFZTZT3K5NYR48",
        "together": "betterstack all page resources",
        "turbopuffer": "incident.io 01KMGBMBN2JWWWC92RADN719MQ,01K0Q28Y8010Y0QES8NQ9TSA0N,01K0Q28Y8002ZDVXC1HEM8WBRA,01KMGBMBN2VKMTFD9T6WBBY1DQ,01KMGBMBN2JJYP251E9JA8WB1H,01K0Q28Y80F4SGGMEYYG7G9GWZ,01K0Q28Y80DA6WT9WN08K0N96C,01K0Q28Y801TPC8YT7PS1CXVMR,01KMGBMBN21AW19JHKPFJJJFN1,01K0Q28Y80TDVJ2HYNEJ99W98G,01K0Q28Y80K7Y1SSEX7Z2NYXNK,01K0Q28Y80NZ19ARGHR79HTKZJ,01K0Q1X4P70458SR04MTQ2CA7F,01K0Q28Y80TXNQD9N86J2EXSRT,01K0Q28Y80N7CW8FF73CEVK0YD,01M1EB2MF3HY0FGY4G4XKG6NWD,01M1ENXV57AJASWNHCRYDGS5N8,01M1ENXV5779G7VTW967EJHE5H,01M1ENXV572CR9QK3M3RB2236R",
        "twelvelabs": "atlassian mvv53x91b74m",
        "voyageai": "atlassian g74wmxgm0zxr",
        "windsurf": "atlassian h6z52njyz22z,170m7l75sh6m",
        "xai": "none",
      }
    `)
  })

  it('uptimeOverLiveComponents is set only where the badge is the same live set', () => {
    for (const s of SERVICES.filter((x) => x.uptimeOverLiveComponents)) {
      expect(s.displayAllComponents, s.id).toBe(true)
      expect(s.statusComponentId, s.id).toBeTruthy()
      expect(s.statusComponentIds, s.id).toBeUndefined()
    }
  })
})
