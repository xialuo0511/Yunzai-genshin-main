import fs from "node:fs"
import YAML from "yaml"

const LIST_URLS = [
  "https://operation-webstatic.mihoyo.com/gacha_info/hk4e/cn_gf01/gacha/list.json",
  "https://webstatic.mihoyo.com/hk4e/gacha_info/cn_gf01/gacha/list.json",
]

const DETAIL_URLS = [
  gachaId => `https://operation-webstatic.mihoyo.com/gacha_info/hk4e/cn_gf01/${gachaId}/zh-cn.json`,
  gachaId => `https://webstatic.mihoyo.com/hk4e/gacha_info/cn_gf01/${gachaId}/zh-cn.json`,
]

const FILES = {
  gachaPool: "./plugins/genshin/defSet/gacha/pool.yaml",
  rolePool: "./plugins/genshin/defSet/pool/301.yaml",
  weaponPool: "./plugins/genshin/defSet/pool/302.yaml",
  gachaDef: "./plugins/genshin/defSet/gacha/gacha.yaml",
  roleElement: "./plugins/genshin/defSet/element/role.yaml",
}

const fetchApi = (...args) => {
  if (globalThis.fetch) {
    return globalThis.fetch(...args)
  }
  return import("node-fetch").then(({ default: fetch }) => fetch(...args))
}

export default class GachaPoolSync {
  constructor(e = {}) {
    this.e = e
  }

  async sync() {
    const list = await this.fetchPoolList()
    const phase = this.pickPhase(list)
    if (!phase.charMain || !phase.weapon) {
      throw new Error("官方卡池数据不完整，未找到角色池或武器池")
    }

    const mainDetail = await this.fetchPoolDetail(phase.charMain.gacha_id)
    const subDetail = phase.charSub ? await this.fetchPoolDetail(phase.charSub.gacha_id) : null
    const weaponDetail = await this.fetchPoolDetail(phase.weapon.gacha_id)

    const data = this.buildPoolData(phase, mainDetail, subDetail, weaponDetail)
    const changedFiles = []

    if (this.updateGachaPool(data.gachaPool)) {
      changedFiles.push(FILES.gachaPool)
    }
    if (this.updateRolePool(data.rolePool)) {
      changedFiles.push(FILES.rolePool)
    }
    if (this.updateWeaponPool(data.weaponPool)) {
      changedFiles.push(FILES.weaponPool)
    }
    if (this.updateRole4BaseList(data.role4)) {
      changedFiles.push(FILES.gachaDef)
    }
    if (this.updateRoleElement(data.roleElement)) {
      changedFiles.push(FILES.roleElement)
    }

    return {
      changed: changedFiles.length > 0,
      changedFiles,
      phase: data.phaseText,
      role5: data.gachaPool.up5,
      role5_2: data.gachaPool.up5_2,
      role4: data.gachaPool.up4,
      weapon5: data.gachaPool.weapon5,
      weapon4: data.gachaPool.weapon4,
      source: LIST_URLS[0],
    }
  }

  async fetchPoolList() {
    let lastErr = null
    for (const url of LIST_URLS) {
      try {
        const res = await fetchApi(url, {
          headers: {
            Referer: "https://www.miyoushe.com",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
        })
        if (!res.ok) continue
        const json = await res.json()
        const list = json?.data?.list
        if (Array.isArray(list) && list.length > 0) return list
      } catch (err) {
        lastErr = err
      }
    }
    throw new Error(`获取官方卡池列表失败${lastErr ? `：${lastErr.message}` : ""}`)
  }

  async fetchPoolDetail(gachaId) {
    let lastErr = null
    for (const getUrl of DETAIL_URLS) {
      try {
        const url = getUrl(gachaId)
        const res = await fetchApi(url, {
          headers: {
            Referer: "https://www.miyoushe.com",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
        })
        if (!res.ok) continue
        return await res.json()
      } catch (err) {
        lastErr = err
      }
    }
    throw new Error(`获取卡池详情失败(${gachaId})${lastErr ? `：${lastErr.message}` : ""}`)
  }

  pickPhase(list) {
    const byType = type => list.filter(v => Number(v.gacha_type) === type)
    const charMain = this.pickBestPool(byType(301))
    const charSubByWindow = byType(400).find(v => this.sameWindow(v, charMain))
    const charSub = charSubByWindow || this.pickBestPool(byType(400))
    const weaponByWindow = byType(302).find(v => this.sameWindow(v, charMain))
    const weapon = weaponByWindow || this.pickBestPool(byType(302))

    return { charMain, charSub, weapon }
  }

  pickBestPool(list) {
    if (!Array.isArray(list) || list.length === 0) return null
    const now = Date.now()
    let best = null
    let bestScore = null
    for (const item of list) {
      const begin = this.toTs(item.begin_time)
      const end = this.toTs(item.end_time)
      if (!begin || !end) continue
      let score
      if (now >= begin && now <= end) {
        // 当前池优先，开服时间越晚越优先
        score = [0, -begin]
      } else if (begin > now) {
        // 未来池按最近时间
        score = [1, begin - now]
      } else {
        // 已结束池按最近结束
        score = [2, now - end]
      }
      if (!best || this.ltScore(score, bestScore)) {
        best = item
        bestScore = score
      }
    }
    return best || list[0]
  }

  ltScore(a, b) {
    if (!b) return true
    if (a[0] !== b[0]) return a[0] < b[0]
    return a[1] < b[1]
  }

  sameWindow(a, b) {
    if (!a || !b) return false
    return a.begin_time === b.begin_time && a.end_time === b.end_time
  }

  toTs(timeStr = "") {
    // 原始时间是国服时间，统一按 +08:00 解析，避免宿主时区差异
    const dt = new Date(timeStr.replace(" ", "T") + "+08:00")
    const ts = dt.getTime()
    return Number.isNaN(ts) ? 0 : ts
  }

  buildPoolData(phase, mainDetail, subDetail, weaponDetail) {
    const role5 = this.extractUp(mainDetail, 5, "角色")
    let role5_2 = subDetail ? this.extractUp(subDetail, 5, "角色") : []
    if (role5_2.length === 0 && Array.isArray(mainDetail?.r5_2_prob_list)) {
      role5_2 = mainDetail.r5_2_prob_list
        .filter(v => Number(v?.is_up) === 1 && v?.item_type === "角色")
        .map(v => v.item_name)
    }
    role5_2 = this.unique(role5_2.filter(v => !role5.includes(v)))
    const role4 = this.unique([
      ...this.extractUp(mainDetail, 4, "角色"),
      ...this.extractUp(subDetail, 4, "角色"),
    ])

    const weapon5 = this.extractUp(weaponDetail, 5, "武器")
    const weapon4 = this.extractUp(weaponDetail, 4, "武器")

    const beginTime = phase.charMain.begin_time
    const endTime = phase.charMain.end_time

    const roleName1 = this.cleanWishTitle(mainDetail?.title) || "角色活动"
    const roleName2 = this.cleanWishTitle(subDetail?.title) || "角色活动-2"
    const rolePoolName = role5_2.length > 0 ? `${roleName1}|${roleName2}` : roleName1
    const weaponPoolName = this.cleanWishTitle(weaponDetail?.title) || "神铸赋形"

    const roleElement = this.collectRoleElement(mainDetail, subDetail)

    return {
      phaseText: `${beginTime} ~ ${endTime}`,
      role4,
      roleElement,
      gachaPool: {
        up4: role4,
        up5: this.unique(role5),
        up5_2: role5_2,
        weapon5: this.unique(weapon5),
        weapon4: this.unique(weapon4),
        endTime,
      },
      rolePool: {
        from: beginTime,
        to: endTime,
        five: this.unique([...role5, ...role5_2]),
        four: role4,
        name: rolePoolName,
      },
      weaponPool: {
        from: phase.weapon.begin_time,
        to: phase.weapon.end_time,
        five: this.unique(weapon5),
        four: this.unique(weapon4),
        name: weaponPoolName,
      },
    }
  }

  extractUp(detail, rank, itemType) {
    const arr = detail?.[`r${rank}_prob_list`]
    if (!Array.isArray(arr)) return []
    return this.unique(
      arr
        .filter(v => Number(v?.is_up) === 1 && Number(v?.rank) === rank && v?.item_type === itemType)
        .map(v => v.item_name)
        .filter(Boolean),
    )
  }

  collectRoleElement(...details) {
    const map = {}
    for (const detail of details) {
      if (!detail) continue
      for (const key of ["r5_up_items", "r4_up_items"]) {
        const arr = detail[key]
        if (!Array.isArray(arr)) continue
        for (const item of arr) {
          if (item?.item_type === "角色" && item?.item_name && item?.item_attr) {
            map[item.item_name] = item.item_attr
          }
        }
      }
    }
    return map
  }

  cleanWishTitle(title = "") {
    return title
      .replace(/<[^>]+>/g, "")
      .replace(/[「」]/g, "")
      .replace(/活动祈愿/g, "")
      .replace(/\s+/g, "")
      .trim()
  }

  unique(arr = []) {
    return [...new Set(arr.filter(Boolean))]
  }

  readYaml(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback
    return YAML.parse(fs.readFileSync(filePath, "utf8"))
  }

  writeYaml(filePath, data) {
    fs.writeFileSync(filePath, YAML.stringify(data), "utf8")
  }

  updateGachaPool(newEntry) {
    const list = this.readYaml(FILES.gachaPool, [])
    if (!Array.isArray(list)) return false
    const first = list[0]
    if (
      first &&
      first.endTime === newEntry.endTime &&
      JSON.stringify(first.up5 || []) === JSON.stringify(newEntry.up5 || []) &&
      JSON.stringify(first.up5_2 || []) === JSON.stringify(newEntry.up5_2 || []) &&
      JSON.stringify(first.up4 || []) === JSON.stringify(newEntry.up4 || []) &&
      JSON.stringify(first.weapon5 || []) === JSON.stringify(newEntry.weapon5 || []) &&
      JSON.stringify(first.weapon4 || []) === JSON.stringify(newEntry.weapon4 || [])
    ) {
      return false
    }
    const next = list.filter(v => v.endTime !== newEntry.endTime)
    next.unshift(newEntry)
    this.writeYaml(FILES.gachaPool, next)
    return true
  }

  updateRolePool(newEntry) {
    const list = this.readYaml(FILES.rolePool, [])
    if (!Array.isArray(list)) return false
    const first = list[0]
    if (
      first &&
      first.from === newEntry.from &&
      first.to === newEntry.to &&
      JSON.stringify(first.five || []) === JSON.stringify(newEntry.five || []) &&
      JSON.stringify(first.four || []) === JSON.stringify(newEntry.four || [])
    ) {
      return false
    }
    const next = list.filter(v => !(v.from === newEntry.from && v.to === newEntry.to))
    next.unshift(newEntry)
    this.writeYaml(FILES.rolePool, next)
    return true
  }

  updateWeaponPool(newEntry) {
    const list = this.readYaml(FILES.weaponPool, [])
    if (!Array.isArray(list)) return false
    const first = list[0]
    if (
      first &&
      first.from === newEntry.from &&
      first.to === newEntry.to &&
      JSON.stringify(first.five || []) === JSON.stringify(newEntry.five || []) &&
      JSON.stringify(first.four || []) === JSON.stringify(newEntry.four || [])
    ) {
      return false
    }
    const next = list.filter(v => !(v.from === newEntry.from && v.to === newEntry.to))
    next.unshift(newEntry)
    this.writeYaml(FILES.weaponPool, next)
    return true
  }

  updateRole4BaseList(role4 = []) {
    const data = this.readYaml(FILES.gachaDef, {})
    if (!data || !Array.isArray(data.role4)) return false
    const missing = role4.filter(v => !data.role4.includes(v))
    if (missing.length === 0) return false
    data.role4.push(...missing)
    this.writeYaml(FILES.gachaDef, data)
    return true
  }

  updateRoleElement(roleElement = {}) {
    const data = this.readYaml(FILES.roleElement, {})
    if (!data || typeof data !== "object") return false
    let changed = false
    for (const name of Object.keys(roleElement)) {
      if (!data[name]) {
        data[name] = roleElement[name]
        changed = true
      }
    }
    if (!changed) return false
    this.writeYaml(FILES.roleElement, data)
    return true
  }
}
