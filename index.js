"use strict"

const Botkit = require("botkit")
const puppeteer = require("puppeteer")
const tempfile = require("tempfile")
const fs = require("fs")
const request = require('request-promise-native')
const sleep = require('await-sleep')


// This configuration can gets overwritten when process.env.SLACK_MESSAGE_EVENTS is given.
const DEFAULT_SLACK_MESSAGE_EVENTS = "direct_message,direct_mention,mention"

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("Error: Specify SLACK_BOT_TOKEN in environment values")
  process.exit(1)
}
if (!((process.env.REDASH_HOST && process.env.REDASH_API_KEY) || (process.env.REDASH_HOSTS_AND_API_KEYS))) {
  console.error("Error: Specify REDASH_HOST and REDASH_API_KEY in environment values")
  console.error("Or you can set multiple Re:dash configs by specifying like below")
  console.error("REDASH_HOSTS_AND_API_KEYS=\"http://redash1.example.com;TOKEN1,http://redash2.example.com;TOKEN2\"")
  process.exit(1)
}

const parseApiKeysPerHost = () => {
  if (process.env.REDASH_HOST) {
    if (process.env.REDASH_HOST_ALIAS) {
      return {[process.env.REDASH_HOST]: {"alias": process.env.REDASH_HOST_ALIAS, "key": process.env.REDASH_API_KEY}}
    } else {
      return {[process.env.REDASH_HOST]: {"alias": process.env.REDASH_HOST, "key": process.env.REDASH_API_KEY}}
    }
  } else {
    return process.env.REDASH_HOSTS_AND_API_KEYS.split(",").reduce((m, host_and_key) => {
      var [host, alias, key] = host_and_key.split(";")
      if (!key) {
        key = alias
        alias = host
      }
      m[host] = {"alias": alias, "key": key}
      return m
    }, {})
  }
}

const redashApiKeysPerHost = parseApiKeysPerHost()
const slackBotToken = process.env.SLACK_BOT_TOKEN
const slackMessageEvents = process.env.SLACK_MESSAGE_EVENTS || DEFAULT_SLACK_MESSAGE_EVENTS

const controller = Botkit.slackbot({
  debug: !!process.env.DEBUG
})

controller.spawn({
  token: slackBotToken
}).startRTM()

Object.keys(redashApiKeysPerHost).forEach((redashHost) => {
  const redashHostAlias = redashApiKeysPerHost[redashHost]["alias"]
  const redashApiKey    = redashApiKeysPerHost[redashHost]["key"]
  controller.hears(`${redashHost}/(queries/([0-9]+)#([0-9]+|table)|public/dashboards/([a-zA-Z0-9]+))`, slackMessageEvents, async (bot, message) => {
    const originalUrl = message.match[0]
    // for embed
    const queryId = message.match[2]
    const visualizationId =  message.match[3]
    // for dashboard
    const dashboardId = message.match[4]

    let query = null
    let visualization = null
    let visualizationPrimaryKey = visualizationId
    if (queryId) {
      try {
        const body = await request.get({ uri: `${redashHost}/api/queries/${queryId}`, qs: { api_key: redashApiKey } })
        query = JSON.parse(body)
        visualization = query.visualizations.find(vis => vis.id.toString() === visualizationId || vis.type.toLowerCase() === visualizationId)
        visualizationPrimaryKey = visualization.id
      } catch (err) {
        bot.botkit.log.error(err)
      }
    }

    let queryUrl = `${redashHostAlias}/queries/${queryId}#${visualizationId}`
    let embedUrl = `${redashHostAlias}/embed/query/${queryId}/visualization/${visualizationPrimaryKey}?api_key=${redashApiKey}`
    let filename = `query-${queryId}-visualization-${visualizationId}.png`
    if (query && visualization) {
      filename = `${query.name}-${visualization.name}-${filename}`
    }
    if (dashboardId) {
      queryUrl = `${redashHostAlias}/public/dashboards/${dashboardId}`
      embedUrl = queryUrl
      filename = `dashboard-${dashboardId}.png`
    }

    bot.reply(message, `Taking screenshot of ${originalUrl}`)
    bot.botkit.log(queryUrl)
    bot.botkit.log(embedUrl)

    const outputFile = tempfile(".png")
    const webshotOptions = {
      shotSize: {
        width: 720,
        height: "all"
      },
    }

    try {
      const browser = await puppeteer.launch({
        executablePath: process.env.CHROMIUM_BROWSER_PATH,
        args: ['--disable-dev-shm-usage', '--no-sandbox']
      })
      const page = await browser.newPage()
      page.setViewport({ width: 720, height: 360 })
      await page.goto(embedUrl)
      await sleep(2000)
      await page.screenshot({ path: outputFile, fullPage: true })
      await browser.close()

      bot.botkit.log.debug(outputFile)
      bot.botkit.log.debug(Object.keys(message))
      bot.botkit.log(message.user + ":" + message.type + ":" + message.channel + ":" + message.text)

      const options = {
        token: slackBotToken,
        filename: filename,
        file: fs.createReadStream(outputFile),
        channels: message.channel
      }

      // bot.api.file.upload cannot upload binary file correctly, so directly call Slack API.
      const body = await request.post({ url: "https://api.slack.com/api/files.upload", formData: options, simple: true })
      bot.botkit.log("ok")
    } catch (err) {
      const msg = `Something wrong happend in take a screen capture : ${err}`
      bot.reply(message, msg)
      bot.botkit.log.error(msg)
    }
  })
})
