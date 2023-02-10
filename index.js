const path = require('path')
const express = require('express')
const cookie = require('cookie')
const getport = require('getport')
const http=require("http");
const os = require('os')
const fs = require('fs')
const socketIO = require('socket.io')
const yaml = require('js-yaml');
const Watcher = require('watcher');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const Updater = require('./updater/index')
const packagejson = require('./package.json')
const BasicAuth = require('./basicauth')
const IPC = require('./ipc')
class Breadmachine {
  ipc = {}
  async init(config) {
    this.config = config
    let settings = await this.settings()
    if (settings.accounts && Object.keys(settings.accounts).length > 0) {
      this.basicauth = new BasicAuth(settings.accounts)
    }
    if (settings.port) {
      this.port = parseInt(settings.port)
    } else {
      this.port = await new Promise((resolve, reject) => {
        getport(function (e, p) {
          if (e) throw e
          resolve(p)
        })
      })
    }
    this.MACHINE_VERSION = packagejson.version
    this.VERSION = config.version ? config.version : ""
    console.log("versions", { agent: this.VERSION, core: this.MACHINE_VERSION })
    this.need_update = null
    this.default_sync_mode = "default"
    this.current_sorter_code = 0
    await this.updateCheck().catch((e) => {
      console.log("update check error", e)
    })
    this.start()

  }
  watch(paths) {
    if (this.watcher) {
      this.watcher.close()
    }
    this.watcher = new Watcher(paths, {
      recursive: true,
      ignoreInitial: true
    })
    this.watcher.on("add", async (filename) => {
      this.io.emit("debug", { added: filename })
      if (filename.endsWith(".png")) {
        for(let session in this.ipc) {
          let ipc = this.ipc[session]
          // try up to 5 times
          for(let i=0; i<5; i++) {
            let res = await ipc.parse(filename)
            if (res) {
              await ipc.push(res)
              break;
            } else {
              // try again in 1 sec
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }
    })
  }
  async settings() {
    let str = await fs.promises.readFile(this.config.config, "utf8")
    const attrs = yaml.load(str)
    const home = os.homedir()
    const folders = attrs.folders.map((c) => {
      let homeResolved = c.replace(/^~(?=$|\/|\\)/, home)
      let relativeResolved = path.resolve(home, homeResolved)
      return relativeResolved
    })
    attrs.folders = folders
    return attrs
  }
  auth(req, res) {
    let session
    if (req.agent === "electron") {
      session = req.get("user-agent")
    } else {
      session = req.cookies.session ? req.cookies.session : uuidv4()
    }
    if (!this.ipc[session]) {
      this.ipc[session] = new IPC(this, session, this.config)
      if (this.config.onconnect) {
        this.config.onconnect(session)
      }
    }
    res.cookie('session', session)
    return session
  }
  start() {
    let app = express()
    const server = http.createServer(app);
    this.io = socketIO(server, {
      cookie: true
    });
    this.io.on('connection', (socket) => {
      let parsed = cookie.parse(socket.handshake.headers.cookie)
      let session = parsed.session
      this.ipc[session].socket = socket
      socket.on('disconnect', () => {
        console.log('Client disconnected')
//        delete this.ipc[session]
      })
    });
    app.use(express.static(path.resolve(__dirname, 'public')))
    app.get('/file', (req, res) => {
      res.sendFile(req.query.file)
    })
    app.use(cookieParser());
    app.use((req, res, next) => {
      let a = req.get("user-agent")
      req.agent = (/breadboard/.test(a) ? "electron" : "web")
      next()
    })
    if (this.basicauth) {
      app.use(this.basicauth.auth.bind(this.basicauth))
    }
    app.use(express.json());
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, "views"))
    app.get("/", async (req, res) => {
      let sync_mode = (req.query.synchronize ? req.query.synchronize : this.default_sync_mode)
      let sync_folder = (req.query.sync_folder ? req.query.sync_folder : "")
      if (req.query && req.query.sorter_code) {
        this.current_sorter_code = req.query.sorter_code
      }
      let session = this.auth(req, res)
      res.render("index", {
        agent: req.agent,
        platform: process.platform,
        query: req.query,
        version: this.VERSION,
        machine_version: this.MACHINE_VERSION,
        sync_mode,
        sync_folder,
        need_update: this.need_update,
        current_sorter_code: this.current_sorter_code,
        theme: this.ipc[session].theme,
        style: this.ipc[session].style,
      })
      if (this.default_sync_mode) this.default_sync_mode = false   // disable sync after the first time at launch
    })
    app.get("/settings", (req, res) => {
      let authorized = (this.basicauth ? true : false)
      let session = this.auth(req, res)
      res.render("settings", {
        authorized,
        agent: req.agent,
        config: this.config.config,
        platform: process.platform,
        version: this.VERSION,
        machine_version: this.MACHINE_VERSION,
        query: req.query,
        theme: this.ipc[session].theme,
        style: this.ipc[session].style,
      })
    })
    app.get("/help", (req, res) => {
      let items = [{
        name: "discord",
        description: "ask questions and share feedback",
        icon: "fa-brands fa-discord",
        href: "https://discord.gg/XahBUrbVwz"
      }, {
        name: "twitter",
        description: "stay updated on Twitter",
        icon: "fa-brands fa-twitter",
        href: "https://twitter.com/cocktailpeanut"
      }, {
        name: "github",
        description: "feature requests and bug report",
        icon: "fa-brands fa-github",
        href: "https://github.com/cocktailpeanut/breadboard/issues"
      }]
      let session = this.auth(req, res)
      res.render("help", {
        agent: req.agent,
        config: this.config.config,
        theme: this.ipc[session].theme,
        style: this.ipc[session].style,
        items,
        platform: process.platform,
        machine_version: this.MACHINE_VERSION,
        version: this.VERSION
      })
    })
    app.get("/connect", (req, res) => {
      let session = this.auth(req, res)
      res.render("connect", {
        agent: req.agent,
        config: this.config.config,
        platform: process.platform,
        version: this.VERSION,
        machine_version: this.MACHINE_VERSION,
        query: req.query,
        theme: this.ipc[session].theme,
        style: this.ipc[session].style,
      })
    })
    app.get("/favorites", (req, res) => {
      let session = this.auth(req, res)
      res.render("favorites", {
        agent: req.agent,
        platform: process.platform,
        version: this.VERSION,
        machine_version: this.MACHINE_VERSION,
        theme: this.ipc[session].theme,
        style: this.ipc[session].style,
      })
    })
    app.get('/card', (req, res) => {
      let session = this.auth(req, res)
      res.render("card", {
        agent: req.agent,
        theme: this.ipc[session].theme,
        style: this.ipc[session].style,
        version: this.VERSION,
        file_path: req.query.file
      })
    })
    app.post("/ipc", async (req, res) => {
      let name = req.body.name
      let args = req.body.args
      let session = this.auth(req, res)
      let r = await this.ipc[session].call(session, name, ...args)
      if (r) {
        res.json(r)
      } else {
        res.json({})
      }
    })
    server.listen(this.port, () => {
      console.log(`Breadboard running at http://localhost:${this.port}`)
    })
    this.app = app
  }
  async updateCheck () {
    if (this.config.releases) {
      const releaseFeed = this.config.releases.feed
      const releaseURL = this.config.releases.url
      const updater = new Updater()
      let res = await updater.check(releaseFeed)
      if (res.feed && res.feed.entry) {
        let latest = (Array.isArray(res.feed.entry) ? res.feed.entry[0] : res.feed.entry)
        if (latest.title === this.VERSION) {
          console.log("UP TO DATE", latest.title, this.VERSION)
        } else {
          console.log("Need to update to", latest.id, latest.updated, latest.title)
          this.need_update = {
            $url: releaseURL,
            latest
          }
        }
      }
    }
  }
}
module.exports = Breadmachine
