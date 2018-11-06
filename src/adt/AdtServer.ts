import { AdtConnection } from "./AdtConnection"
import { Uri, FileSystemError, FileType } from "vscode"
import { MetaFolder } from "../fs/MetaFolder"
import { AbapObjectNode, AbapNode } from "../fs/AbapNode"
import { AbapObject } from "../abap/AbapObject"
import { getRemoteList } from "../config"
export const ADTBASEURL = "/sap/bc/adt/repository/nodestructure"

// visual studio paths are hierarchic, adt ones aren't
// so we need a way to translate the hierarchic ones to the original ones
// this file is concerned with telling whether a path is a real ADT one or one from vscode
// /sap/bc/adt/repository/nodestructure (with ampty query) is the root of both
// also, several objects have namespaces.
//  Class /foo/bar of package /foo/baz in code will have a path like
//    /sap/bc/adt/repository/nodestructure/foo/baz/foo/bar
//  the actual adt path would be something like:
//    /sap/bc/adt/oo/classes/%2Ffoo%2Fbar
//  so we need to do quite a bit of transcoding
const uriParts = (uri: Uri): string[] =>
  uri.path
    .split("/")
    .filter((v, idx, arr) => (idx > 0 && idx < arr.length - 1) || v) //ignore empty at begginning or end

export class AdtServer {
  readonly connectionId: string
  readonly connectionP: Promise<AdtConnection>
  private root: MetaFolder

  findNode(uri: Uri): AbapNode {
    const parts = uriParts(uri)
    return parts.reduce((current: any, name) => {
      if (current && "getChild" in current) return current.getChild(name)
      throw FileSystemError.FileNotFound(uri)
    }, this.root)
  }

  async stat(uri: Uri) {
    const node = await this.findNodePromise(uri)
    if (node.canRefresh()) {
      const conn = await this.connectionP
      if (node.type === FileType.Directory) await node.refresh(conn)
      else await node.stat(conn)
    }
    return node
  }

  async findNodePromise(uri: Uri): Promise<AbapNode> {
    let node: AbapNode = this.root
    const parts = uriParts(uri)
    for (const part of parts) {
      let next: AbapNode | undefined = node.getChild(part)
      if (!next && node.canRefresh()) {
        const conn = await this.connectionP
        await node.refresh(conn)
        next = node.getChild(part)
      }
      if (next) node = next
      else return Promise.reject(FileSystemError.FileNotFound(uri))
    }

    return node
  }

  constructor(connectionId: string) {
    const config = getRemoteList().filter(
      config => config.name.toLowerCase() === connectionId.toLowerCase()
    )[0]

    if (!config) throw new Error(`connection ${connectionId}`)

    const connection = AdtConnection.fromRemote(config)

    this.connectionId = config.name.toLowerCase()
    this.connectionP = connection.waitReady()
    connection.connect()

    this.root = new MetaFolder()
    this.root.setChild(
      `$TMP`,
      new AbapObjectNode(new AbapObject("DEVC/K", "$TMP", ADTBASEURL, "X"))
    )
    this.root.setChild(
      "System Library",
      new AbapObjectNode(new AbapObject("DEVC/K", "", ADTBASEURL, "X"))
    )
  }
}
const servers = new Map<string, AdtServer>()
export const getServer = (connId: string): AdtServer => {
  let server = servers.get(connId)
  if (!server) {
    server = new AdtServer(connId)
    servers.set(connId, server)
  }
  return server
}
export const fromUri = (uri: Uri) => {
  if (uri.scheme === "adt") return getServer(uri.authority)
  throw FileSystemError.FileNotFound(uri)
}
