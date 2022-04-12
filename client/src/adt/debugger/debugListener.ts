import { ADTClient, Debuggee, isDebugListenerError, DebuggingMode, isAdtError } from "abap-adt-api"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { log, caughtToString } from "../../lib"
import { DebugProtocol } from "vscode-debugprotocol"
import { Disposable, EventEmitter } from "vscode"
import { getOrCreateClient } from "../conections"
import { homedir } from "os"
import { join } from "path"
import { StoppedEvent, TerminatedEvent } from "vscode-debugadapter"
import { v1 } from "uuid"
import { getWinRegistryReader } from "./winregistry"
import { context } from "../../extension"

type ConflictResult = { with: "none" } | { with: "other" | "myself", message?: string }

const ATTACHTIMEOUT = "autoAttachTimeout"
const sessionNumbers = new Map<string, number>()

export interface DebuggerUI {
    Confirmator: (message: string) => Thenable<boolean>
    ShowError: (message: string) => any
}

const getOrCreateIdeId = (): string => {
    const ideId = context.workspaceState.get("adt.ideId")
    if (typeof ideId === "string") return ideId
    const newIdeId = v1().replace(/-/g, "").toUpperCase()
    context.workspaceState.update("adt.ideId", newIdeId)
    return newIdeId
}

const getOrCreateTerminalId = async () => {
    if (process.platform === "win32") {
        const reg = getWinRegistryReader()
        const terminalId = reg && reg("HKEY_CURRENT_USER", "Software\\SAP\\ABAP Debugging", "TerminalID")
        if (!terminalId) throw new Error("Unable to read terminal ID from windows registry")
        return terminalId
    } else {
        const cfgpath = join(homedir(), ".SAP/ABAPDebugging")
        const cfgfile = join(cfgpath, "terminalId")
        try {
            return readFileSync(cfgfile).toString("utf8")
        } catch (error) {
            const terminalId = v1().replace(/-/g, "").toUpperCase()
            if (!existsSync(cfgpath)) mkdirSync(cfgpath, { recursive: true })
            writeFileSync(cfgfile, terminalId)
            return terminalId
        }
    }
}

const errorType = (err: any): string | undefined => {
    try {
        const exceptionType = err?.properties?.["com.sap.adt.communicationFramework.subType"]
        if (!exceptionType && `${err.response.body}`.match(/Connection timed out/)) return ATTACHTIMEOUT
        return exceptionType
    } catch (error) {/**/ }
}

const isConflictError = (e: any) => (errorType(e) || "").match(/conflictNotification|conflictDetected/)

export class DebugListener {
    private active: boolean = false
    private attached: boolean = false
    private killed = false
    private ideId: string
    private notifier: EventEmitter<DebugProtocol.Event> = new EventEmitter()
    private listeners: Disposable[] = []
    private readonly mode: DebuggingMode
    public readonly THREADID = 1
    private doRefresh?: NodeJS.Timeout
    sessionNumber: number
    private get client() {
        if (this.killed) throw new Error("Disconnected")
        return this._client
    }

    constructor(private connId: string, private _client: ADTClient, private terminalId: string,
        private username: string, terminalMode: boolean, private ui: DebuggerUI) {
        this.sessionNumber = (sessionNumbers.get(connId) || 0) + 1
        sessionNumbers.set(connId, this.sessionNumber)
        this.ideId = getOrCreateIdeId()
        this.mode = terminalMode ? "terminal" : "user"
        if (!this.username) this.username = _client.username.toUpperCase()
    }
    addListener(listener: (e: DebugProtocol.Event) => any, thisArg?: any) {
        return this.notifier.event(listener, thisArg, this.listeners)
    }

    public static async create(connId: string, ui: DebuggerUI, username: string, terminalMode: boolean) {
        const client = await getOrCreateClient(connId)
        if (!client) throw new Error(`Unable to get client for${connId}`)
        const terminalId = await getOrCreateTerminalId()
        return new DebugListener(connId, client, terminalId, username, terminalMode, ui)
    }

    private async stopListener(norestart = true) {
        if (norestart) {
            this.active = false
        }
        const c = this._client.statelessClone
        return c.debuggerDeleteListener(this.mode, this.terminalId, this.ideId, this.username)
    }

    private debuggerListen() {
        return this.client.statelessClone.debuggerListen(this.mode, this.terminalId, this.ideId, this.username)
    }

    private async hasConflict(): Promise<ConflictResult> {
        try {
            await this.client.statelessClone.debuggerListeners(this.mode, this.terminalId, this.ideId, this.username)
        } catch (error: any) {
            if (isConflictError(error)) return { with: "other", message: error?.properties?.conflictText }
            throw error
        }
        try {
            await this.client.statelessClone.debuggerListeners(this.mode, this.terminalId, this.ideId, this.username)
        } catch (error: any) {
            if (isConflictError(error)) return { with: "myself", message: error?.properties?.conflictText }
            throw error
        }
        return { with: "none" }
    }

    public async fireMainLoop(): Promise<boolean> {
        try {
            const conflict = await this.hasConflict()
            switch (conflict.with) {
                case "myself":
                    await this.stopListener()
                    this.mainLoop()
                    return true
                case "other":
                    const resp = await this.ui.Confirmator(`${conflict.message || "Debugger conflict detected"} Take over debugging?`)
                    if (resp) {
                        await this.stopListener(false)
                        this.mainLoop()
                        return true
                    }
                    return false
                case "none":
                    this.mainLoop()
                    return true
            }
        } catch (error) {
            this.ui.ShowError(`Error listening to debugger: ${caughtToString(error)}`)
            return false
        }

    }


    private async mainLoop() {
        this.active = true
        while (this.active) {
            try {
                log(`Debugger ${this.sessionNumber} listening on connection  ${this.connId}`)
                const debuggee = await this.debuggerListen()
                if (!debuggee || !this.active) continue
                log(`Debugger ${this.sessionNumber} disconnected`)
                if (isDebugListenerError(debuggee)) {
                    log(`Debugger ${this.sessionNumber} reconnecting to ${this.connId}`)
                    // reconnect
                    break
                }
                log(`Debugger ${this.sessionNumber} on connection  ${this.connId} reached a breakpoint`)
                await this.onBreakpointReached(debuggee)
            } catch (error) {
                if (!this.active) return
                if (!isAdtError(error)) {
                    this.ui.ShowError(`Error listening to debugger: ${caughtToString(error)}`)
                } else {
                    // autoAttachTimeout
                    const exceptionType = errorType(error)
                    switch (exceptionType) {
                        case "conflictNotification":
                        case "conflictDetected":
                            const txt = error?.properties?.conflictText || "Debugger terminated by another session/user"
                            this.ui.ShowError(txt)
                            await this.stopDebugging(false)
                            break
                        case ATTACHTIMEOUT:
                            // this.refresh()
                            break
                        default:
                            const quit = await this.ui.Confirmator(`Error listening to debugger: ${caughtToString(error)} Close session?`)
                            if (quit) await this.stopDebugging()
                    }
                }
            }
        }
    }




    private async onBreakpointReached(debuggee: Debuggee) {
        try {
            if (!this.attached)
                await this.client.debuggerAttach(this.mode, debuggee.DEBUGGEE_ID, this.username, true)
            this.attached = true
            await this.client.debuggerSaveSettings({})
            this.notifier.fire(new StoppedEvent("breakpoint", this.THREADID))
        } catch (error) {
            log(`${error}`)
            await this.stopDebugging()
        }
    }

    public async stopDebugging(stopDebugger = true) {
        this.active = false
        if (stopDebugger) {
            const c = this.client.statelessClone
            const running = await c.debuggerListeners("user", this.terminalId, this.ideId, this.username).catch(isConflictError)
            if (running) await this.stopListener()
        }
        this.notifier.fire(new TerminatedEvent())
    }

    public async logout() {
        const ignore = () => undefined
        this.active = false
        this.attached = false
        if (this.killed) return
        const client = this.client
        const stop = this.hasConflict().then(r => { if (r.with === "myself") return this.stopListener().catch(ignore) }, ignore)
        const proms: Promise<any>[] = [stop]
        this.killed = true

        const logout = () => Promise.all([client.logout(), client.statelessClone.logout()])
        if (client.loggedin)
            proms.push(stop.then(() => client.dropSession(), ignore).then(logout, ignore))
        await Promise.all(proms)
    }
}
