import plugin from "../../../lib/plugins/plugin.js"
import gsCfg from "../model/gsCfg.js"
import GachaPoolSync from "../model/gachaPoolSync.js"
import fs from "node:fs"

gsCfg.cpCfg("gacha", "sync")

export class poolSync extends plugin {
  constructor() {
    super({
      name: "原神卡池同步",
      dsc: "自动同步原神活动祈愿卡池（官方数据）",
      event: "message",
      priority: 500,
      rule: [
        {
          reg: "^#?(原神)?(更新|同步)(抽卡|祈愿|卡池)(数据)?$",
          permission: "master",
          fnc: "syncNow",
        },
      ],
    })

    const syncCfg = gsCfg.getConfig("gacha", "sync") || {}
    this.task = {
      cron: syncCfg.cron || "0 5 4 * * ?",
      name: "原神卡池自动同步任务",
      fnc: () => this.syncTask(),
      log: false,
    }
  }

  async init() {
    const file = "./plugins/genshin/config/gacha.sync.yaml"
    if (!fs.existsSync(file)) {
      gsCfg.cpCfg("gacha", "sync")
    }
  }

  async syncTask() {
    const syncCfg = gsCfg.getConfig("gacha", "sync") || {}
    if (syncCfg?.enabled === false) return
    try {
      const ret = await new GachaPoolSync(this.e).sync()
      if (ret.changed) {
        logger.mark(
          `[原神卡池自动同步] 已更新 ${ret.phase} 角色:${ret.role5.join("、")}${ret.role5_2.length ? `|${ret.role5_2.join("、")}` : ""} 武器:${ret.weapon5.join("、")}`,
        )
      } else {
        logger.mark(`[原神卡池自动同步] 无变更（${ret.phase}）`)
      }
    } catch (err) {
      logger.error(`[原神卡池自动同步] 失败：${err.message || err}`)
    }
  }

  async syncNow() {
    try {
      const ret = await new GachaPoolSync(this.e).sync()
      const msg = [
        `同步来源：${ret.source}`,
        `卡池区间：${ret.phase}`,
        `角色五星：${ret.role5.join("、")}${ret.role5_2.length ? `｜${ret.role5_2.join("、")}` : ""}`,
        `角色四星：${ret.role4.join("、")}`,
        `武器五星：${ret.weapon5.join("、")}`,
        `武器四星：${ret.weapon4.join("、")}`,
      ]
      if (ret.changed) {
        msg.push(`已更新文件：\n${ret.changedFiles.join("\n")}`)
      } else {
        msg.push("本地配置已是最新，无需更新")
      }
      await this.reply(msg.join("\n"))
    } catch (err) {
      await this.reply(`同步失败：${err.message || err}`)
    }
  }
}
