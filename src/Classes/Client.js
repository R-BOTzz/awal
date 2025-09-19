"use strict";

const Baileys = require("baileys");
const pino = require("pino");
const EventEmitter = require("node:events");
const { Collection } = require("@discordjs/collection");
const { Consolefy } = require("@mengkodingan/consolefy");
const { NodeCache } = require("@cacheable/node-cache");
const Events = require("../Constant/Events.js");
const fs = require("node:fs");
const Functions = require("../Helper/Functions.js");
const ExtractEventsContent = require("../Handler/ExtractEventsContent.js");
const Ctx = require("./Ctx.js");
const MessageEventList = require("../Handler/MessageEvents.js");

class Client {
    constructor(opts) {
        this.authDir = opts.authDir ?? "./state";
        this.authAdapter = opts.authAdapter ?? Baileys.useMultiFileAuthState(this.authDir);
        this.browser = opts.browser ?? Baileys.Browsers.ubuntu("CHROME");
        this.WAVersion = opts.WAVersion;
        this.printQRInTerminal = opts.printQRInTerminal ?? true;
        this.qrTimeout = opts.qrTimeout ?? 60000;
        this.phoneNumber = opts.phoneNumber;
        this.usePairingCode = opts.usePairingCode ?? false;
        this.customPairingCode = opts.customPairingCode ?? false;
        this.logger = opts.logger ?? pino({
            level: "fatal"
        });
        this.useStore = opts.useStore ?? false;
        this.readIncomingMsg = opts.readIncomingMsg ?? false;
        this.markOnlineOnConnect = opts.markOnlineOnConnect ?? true;
        this.prefix = opts.prefix;
        this.selfReply = opts.selfReply ?? false;
        this.autoMention = opts.autoMention ?? false;
        this.autoAiLabel = opts.autoAiLabel ?? false;

        this.fallbackWAVersion = [2, 3000, 1021387508];
        this.ev = new EventEmitter();
        this.cmd = new Collection();
        this.cooldown = new Collection();
        this.hearsMap = new Collection();
        this.middlewares = new Collection();
        this.consolefy = new Consolefy();
        this.store = Baileys.makeInMemoryStore({});
        this.storePath = `${this.authDir}/gktw_store.json`;
        this.groupCache = new NodeCache({
            stdTTL: 30 * 60,
            useClones: false
        });
        this.messageIdCache = new NodeCache({
            stdTTL: 30,
            useClones: false
        });
        this.jidsPath = `${this.authDir}/jids.json`;
        this.jids = {};

        if (typeof this.prefix === "string") this.prefix = this.prefix.split("");
    }

    onConnectionUpdate() {
        this.core.ev.on("connection.update", (update) => {
            this.ev.emit(Events.ConnectionUpdate, update);
            const {
                connection,
                lastDisconnect
            } = update;

            if (update.qr) this.ev.emit(Events.QR, update.qr);

            if (connection === "close") {
                const shouldReconnect = lastDisconnect.error.output.statusCode !== Baileys.DisconnectReason.loggedOut;
                this.consolefy.error(`Connection closed due to ${lastDisconnect.error}, reconnecting ${shouldReconnect}`);
                if (shouldReconnect) this.launch();
            } else if (connection === "open") {
                this.readyAt = Date.now();
                this.ev.emit(Events.ClientReady, this.core);
            }
        });
    }

    onCredsUpdate() {
        this.core.ev.on("creds.update", this.saveCreds);
    }

    saveJids() {
        fs.writeFileSync(this.jidsPath, JSON.stringify(this.jids));
    }

    async runMiddlewares(ctx, index = 0) {
        const middlewareFn = this.middlewares.get(index);
        if (!middlewareFn) return true;

        let nextCalled = false;
        let middlewareCompleted = false;

        await middlewareFn(ctx, async () => {
            if (nextCalled) throw new Error("next() called multiple times in middleware");
            nextCalled = true;
            middlewareCompleted = await this.runMiddlewares(ctx, index + 1);
        });

        if (!nextCalled && !middlewareCompleted) return false;

        return middlewareCompleted;
    }

    use(fn) {
        this.middlewares.set(this.middlewares.size, fn);
    }

    onMessage() {
        try {
            Object.assign(this.jids, JSON.parse(fs.readFileSync(this.jidsPath).toString()));
        } catch (error) {
            fs.writeFileSync(this.jidsPath, JSON.stringify(this.jids));
        }

        this.core.ev.on("messages.upsert", async (event) => {
            for (const message of event.messages) {
                if (this.messageIdCache.get(message.key.id)) return;
                this.messageIdCache.set(message.key.id, true);

                if (Baileys.isJidGroup(message.key.remoteJid)) await this.setGroupCache(message.key.remoteJid);

                const messageType = Baileys.getContentType(message.message) ?? "";
                const text = Functions.getContentFromMsg(message) ?? "";
                const senderJid = Functions.getSender(message, this.core);
                const senderLid = await Functions.convertJid("lid", senderJid, this.jids, this.core);

                if (message.pushName && !this.jids[senderLid] || this.jids[senderLid]?.pushName !== message.pushName) {
                    this.jids[senderLid] = {
                        ...(this.jids[senderLid] || {}),
                        pushName: message.pushName
                    };
                    if (Baileys.isJidUser(senderJid)) this.jids[senderLid].pn = senderJid;
                    this.saveJids();
                }

                const msg = {
                    ...message,
                    content: text,
                    senderLid,
                    messageType
                };

                const self = {
                    ...this,
                    m: msg
                };

                const used = ExtractEventsContent(msg, messageType);
                const ctx = new Ctx({
                    used,
                    args: [],
                    self,
                    client: this.core
                });

                if (MessageEventList[messageType]) await MessageEventList[messageType](msg, this.ev, self, this.core);
                this.ev.emit(Events.MessagesUpsert, msg, ctx);
                if (this.readIncomingMsg) await this.core.readMessages([message.key]);
                await require("../Handler/Commands.js")(self, this.runMiddlewares.bind(this));
            }
        });
    }

    onGroupsJoin() {
        this.core.ev.on("groups.upsert", (event) => {
            this.ev.emit(Events.GroupsJoin, event);
        });
    }

    async setGroupCache(id) {
        if (!this.groupCache.get(id)) {
            const metadata = await this.core.groupMetadata(id);
            this.groupCache.set(id, metadata);
        }
    }

    onGroupsUpdate() {
        this.core.ev.on("groups.update", async ([event]) => {
            await this.setGroupCache(event.id);
        });
    }

    onGroupParticipantsUpdate() {
        this.core.ev.on("group-participants.update", async (event) => {
            await this.setGroupCache(event.id);

            if (event.action === "add") {
                return this.ev.emit(Events.UserJoin, event);
            } else if (event.action === "remove") {
                return this.ev.emit(Events.UserLeave, event);
            }
        });
    }

    onCall() {
        this.core.ev.on("call", (event) => {
            const _event = event.map(async (call) => ({
                ...call,
                fromLid: await Functions.convertJid("lid", call.from, this.jids, this.core)
            }));
            this.ev.emit(Events.Call, _event);
        });
    }

    command(opts, code) {
        if (typeof opts !== "string") return this.cmd.set(this.cmd.size, opts);
        if (!code) code = () => null;

        return this.cmd.set(this.cmd.size, {
            name: opts,
            code
        });
    }

    hears(query, callback) {
        this.hearsMap.set(this.hearsMap.size, {
            name: query,
            code: callback
        });
    }

    async groups() {
        return await this.core.groupFetchAllParticipating();
    }

    async bio(content) {
        await this.core.updateProfileStatus(content);
    }

    async fetchBio(jid) {
        const decodedJid = Functions.decodeJid(jid ? jid : this.core.user.id);
        return await this.core.fetchStatus(decodedJid);
    }

    decodeJid(jid) {
        return Functions.decodeJid(jid);
    }

    getPushname(jid) {
        return Functions.getPushname(jid, this.jids);
    }

    getId(jid) {
        return Functions.getId(jid);
    }

    async convertJid(type, jid) {
        return await Functions.convertJid(type, jid, this.jids, this.core);
    }

    async launch() {
        const {
            state,
            saveCreds
        } = await this.authAdapter;
        this.state = state;
        this.saveCreds = saveCreds;

        if (this.useStore) {
            this.store.readFromFile(this.storePath);
            setInterval(() => {
                this.store.writeToFile(this.storePath);
            }, 10_000)
        }

        const version = this.WAVersion ? this.WAVersion : this.fallbackWAVersion;
        this.core = Baileys.default({
            version,
            browser: this.browser,
            logger: this.logger,
            printQRInTerminal: this.printQRInTerminal,
            emitOwnEvents: this.selfReply,
            auth: this.state,
            markOnlineOnConnect: this.markOnlineOnConnect,
            shouldSyncHistoryMessage: (msg) => {
                const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
                return msg.messageTimestamp * 1000 > twoDaysAgo;
            },
            cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
            qrTimeout: this.qrTimeout,
            msgRetryCounterCache: new NodeCache({
                stdTTL: 300,
                checkperiod: 60
            })
        });

        if (this.useStore) {
            this.store.bind(this.core.ev);

            setInterval(() => {
                const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
                this.store.cleanupMessages(cutoff);
            }, 24 * 60 * 60 * 1000)
        }

        if (this.usePairingCode && !this.core.authState.creds.registered) {
            this.consolefy.setTag("pairing-code");

            if (this.printQRInTerminal) {
                this.consolefy.error("If you are set usePairingCode to true then you need to set printQRInTerminal to false.");
                this.consolefy.resetTag();
                return;
            }

            if (!this.phoneNumber) {
                this.consolefy.error("phoneNumber options are required if you are using usePairingCode.");
                this.consolefy.resetTag();
                return;
            }

            this.phoneNumber = this.phoneNumber.replace(/[^0-9]/g, "");

            if (!this.phoneNumber.length) {
                this.consolefy.error("Invalid phoneNumber.");
                this.consolefy.resetTag();
                return;
            }

            const res = await fetch("https://gist.githubusercontent.com/itsreimau/3da60a4937a66e4b1ac34970500e926b/raw/5f4a57faf6d0133c37db60192915d4686e865329/PHONENUMBER_MCC.json");
            const PHONENUMBER_MCC = await res.json();

            if (!Array.isArray(PHONENUMBER_MCC)) {
                this.consolefy.error("Invalid MCC data received.");
                this.consolefy.resetTag();
                return;
            }

            setTimeout(async () => {
                const code = this.customPairingCode ? await this.core.requestPairingCode(this.phoneNumber, this.customPairingCode) : await this.core.requestPairingCode(this.phoneNumber);

                this.consolefy.info(`Pairing Code: ${code}`);
                this.consolefy.resetTag();
            }, 3000);
        }

        this.onConnectionUpdate();
        this.onCredsUpdate();
        this.onMessage();
        this.onGroupsJoin();
        this.onGroupsUpdate();
        this.onGroupParticipantsUpdate();
        this.onCall();
    }
}

module.exports = Client;
