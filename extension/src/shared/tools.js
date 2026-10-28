// 工具定义（JSON Schema）。
// 这里的描述直接进入模型上下文，写得越清楚，模型用得越准。
// 关键：描述里要写「什么时候该用」和「怎么用」，而不只是「这是什么」。

export const TOOLS = [
  {
    name: 'page.read',
    description:
      '读取当前网页的正文内容，返回标题、URL、Markdown 正文、元信息和标题大纲。' +
      '当用户问「这篇文章讲了什么」「总结这个页面」「把这个网页保存下来」时使用。' +
      '返回的 markdown 已经清洗过噪音，可以直接引用。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '目标标签页 ID；不填则用当前活动页' },
        maxLength: { type: 'integer', description: '正文最大字符数，默认 30000' },
      },
    },
  },
  {
    name: 'page.screenshot',
    description:
      '截取当前页面可见区域的截图（PNG）。当需要理解页面视觉布局、' +
      '确认某个元素位置、或页面文字无法反映界面结构时使用。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '目标标签页 ID' },
      },
    },
  },
  {
    name: 'page.links',
    description:
      '列出当前页面里的链接。可用 filter 过滤：ext 指定扩展名（如 "pdf,docx"）、' +
      'contains 按关键词过滤、sameOrigin 设为 false 则包含站外链接、limit 控制数量上限。' +
      '当用户要「批量下载这个页面上所有 PDF」或「找出所有视频链接」时，先用这个工具列出候选。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        filter: {
          type: 'object',
          properties: {
            ext: { type: 'string', description: '扩展名列表，逗号分隔，如 "pdf,mp4,docx"' },
            contains: { type: 'string', description: '链接文本或 URL 中需包含的关键词' },
            sameOrigin: { type: 'boolean', description: '是否只返回同域链接，默认 true' },
            limit: { type: 'integer', description: '最多返回多少条，默认 500' },
          },
        },
      },
    },
  },
  {
    name: 'page.tables',
    description: '提取页面中所有 HTML 表格的结构化数据（表头 + 行）。当页面是数据报表、价格表时使用。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },
  {
    name: 'page.images',
    description: '列出页面中的图片及其尺寸与 alt 文本。当用户要「把页面上的图都下载下来」时使用。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        limit: { type: 'integer', description: '默认 200' },
      },
    },
  },
  {
    name: 'page.interactive',
    description:
      '列出页面上可交互元素（链接、按钮、输入框等），返回 index、selector、文本。' +
      '当需要点击或填写某个控件但不知道选择器时，先调用这个工具拿到 index，再用 page.click / page.fill。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        limit: { type: 'integer', description: '默认 200' },
      },
    },
  },
  {
    name: 'page.click',
    description: '点击页面元素。可用 selector（CSS 选择器）或 index（page.interactive 返回的序号）指定。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string', description: 'CSS 选择器，如 "button.submit"' },
        index: { type: 'integer', description: 'page.interactive 返回的元素序号' },
      },
    },
  },
  {
    name: 'page.fill',
    description:
      '填写输入框或文本域。可用 selector 或 index 指定，value 为要填的内容，submit 为 true 时填完自动提交。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string' },
        index: { type: 'integer' },
        value: { type: 'string', description: '要填入的文本' },
        submit: { type: 'boolean', description: '是否填完后自动回车/提交' },
      },
      required: ['value'],
    },
  },
  {
    name: 'page.scroll',
    description: '滚动页面。to 可为 top / bottom / down；给 selector 则滚动到该元素位置。加载更多内容时用 to=bottom。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        to: { type: 'string', enum: ['top', 'bottom', 'down'] },
        selector: { type: 'string' },
      },
    },
  },
  {
    name: 'page.highlight',
    description: '高亮页面上的某个元素（红色描边），用于让用户肉眼确认模型打算操作的位置。执行破坏性操作前建议先高亮。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string' },
        index: { type: 'integer' },
      },
    },
  },
  {
    name: 'page.selection',
    description:
      '读取用户在当前页面上选中的文字（连同所在段落/章节的上下文）。' +
      '当用户说「这段」「这些字」「我选中的」而没有贴出内容时，' +
      '先用这个工具拿到选区文本再回答。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },
  {
    name: 'page.eval',
    description:
      '在页面上下文中执行一段 JavaScript 表达式（自动包装为 async 函数，返回其结果）。' +
      '仅在标准工具无法达成时使用，例如读取页面内部 JS 变量。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        code: { type: 'string', description: '要执行的 JavaScript 代码' },
      },
      required: ['code'],
    },
  },

  {
    name: 'style.apply',
    description:
      '向当前页面注入自定义 CSS 来修改网站样式。可用 scope 把规则限定在某个选择器范围内（避免污染全站）。' +
      '当用户说「把这个网站的字体改大」「去掉广告」「换个配色」时使用。' +
      '常用预设请优先用 style.preset，它更安全。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        css: { type: 'string', description: 'CSS 规则文本' },
        name: { type: 'string', description: '规则名，后续可用 style.remove 删除' },
        scope: { type: 'string', description: '可选的作用域选择器，如 ".article-body"' },
      },
      required: ['css'],
    },
  },
  {
    name: 'style.preset',
    description:
      '应用内置样式预设。可选值：dark（深色模式）、light（强制浅色）、compact（紧凑排版）、' +
      'readable（阅读模式，隐藏侧栏并限制行宽）、hideImages（隐藏图片）、wide（全宽）。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        preset: {
          type: 'string',
          enum: ['dark', 'light', 'compact', 'readable', 'hideImages', 'wide'],
        },
      },
      required: ['preset'],
    },
  },
  {
    name: 'style.hide',
    description: '隐藏匹配指定 CSS 选择器的元素。例如 hide 用 ["#ad-banner", ".sponsor"] 去掉广告位。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selectors: { type: 'array', items: { type: 'string' } },
      },
      required: ['selectors'],
    },
  },
  {
    name: 'style.list',
    description:
      '列出当前页面上所有已注入的自定义样式规则及其名称。' +
      '当用户问「现在改了什么」「还有哪些样式规则」时使用，' +
      '也可在移除某条规则前先确认它的 name。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },
  {
    name: 'style.remove',
    description:
      '按名称移除某一条已注入的样式规则（name 来自 style.list 的返回）。' +
      '当用户只想撤销某条特定改版、保留其他改动时使用；' +
      '若用户想全部还原，用 style.reset。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        name: { type: 'string', description: '要移除的规则名称，如 "preset-dark"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'style.reset',
    description:
      '清除当前页面上所有由本扩展注入的样式，让网站完全恢复原始外观。' +
      '当用户说「还原」「撤销所有修改」「恢复正常」时使用。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },

  {
    name: 'style.save',
    description:
      '把当前页面已注入的样式规则按域名保存下来，之后访问该网站会自动应用同样的改版。' +
      '当用户说「以后这个网站都这样」「把这个改版保存下来」「记住这个站点的样式」时使用。' +
      '必须先用 style.preset / style.apply 应用样式，再调用本工具。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },
  {
    name: 'style.rules',
    description:
      '管理已保存的站点样式规则。' +
      '不带 action 时列出所有站点及其规则；action=clear 清除当前站点的全部规则；' +
      'action=remove 配合 name 移除当前站点的某一条规则。' +
      '当用户问「我在哪些网站改过样式」「把这个网站的改版撤销」时使用。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        action: { type: 'string', enum: ['list', 'clear', 'remove'] },
        name: { type: 'string', description: '要移除的规则名称' },
      },
    },
  },
  {
    name: 'media.list',
    description:
      '列出页面中已加载的媒体与资源 URL（视频、音频、图片、文档，以及被 hook 到的 fetch/XHR 请求）。' +
      '当用户要「下载这个视频」「批量下载页面里的媒体」时先用它确认有哪些 URL。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        limit: { type: 'integer', description: '默认 300' },
      },
    },
  },
  {
    name: 'media.download',
    description:
      '批量下载资源文件。可传 urls 数组（字符串或 {url, filename} 对象）。' +
      '会带上当前登录态的 Cookie 与 Referer，因此登录后才能访问的文件也能下载。' +
      'HLS/DASH 播放清单（.m3u8/.mpd）会自动转交本地 companion 用 ffmpeg 合并成单个文件；' +
      '此时需要 companion 已运行且配置了 ffmpeg 路径，否则会返回明确错误。',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  filename: { type: 'string' },
                },
                required: ['url'],
              },
            ],
          },
        },
        concurrency: { type: 'integer', description: '并发数，默认 3' },
        referer: { type: 'string', description: '可选的 Referer 头' },
      },
      required: ['urls'],
    },
  },

  {
    name: 'table.docs',
    description:
      '采集表格单元格里的文档下载链接（PDF/Word/Excel 等），并带上行标签与列标题。' +
      '当页面上是清单/报表类表格、每一行每一列都藏着一个文档链接时使用。' +
      '会自动翻页累积（最多 maxPages 页），返回每条链接的行/列上下文，' +
      '便于确认要下载哪些、以及生成有意义的文件名。' +
      '若目的是直接下载，请用 table.download。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        exts: {
          type: 'string',
          description: '要识别的扩展名，逗号分隔。默认 "pdf,doc,docx,xls,xlsx,ppt,pptx,csv,zip"',
        },
        maxPages: { type: 'integer', description: '最多加载多少屏/页，默认 10' },
        waitMs: { type: 'integer', description: '每次加载后等待的毫秒数，默认 1000' },
        tableIndex: { type: 'integer', description: '只处理第几个表格；不填则处理全部' },
        scroll: {
          type: 'string',
          enum: ['auto', 'paged', 'scrolled'],
          description:
            '加载方式。auto（默认）自动判断：有分页控件就翻页，没有就滚动加载。' +
            'scrolled 强制滚动加载（用于无限滚动页面）。',
        },
      },
    },
  },
  {
    name: 'table.download',
    description:
      '批量下载表格中的所有文档链接（自动翻页/滚动加载收集全部内容）。' +
      '这是「把这个清单页上的 PDF 都下载下来」这类需求的正确工具。' +
      '文件会用「行标签_列标题.pdf」的方式命名，避免下载出一堆无意义的文件名。' +
      '下载前会返回每个文件的来源行/列，方便向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        exts: {
          type: 'string',
          description: '要下载的文档扩展名，逗号分隔。默认 "pdf,doc,docx,xls,xlsx,ppt,pptx,csv,zip"',
        },
        maxPages: { type: 'integer', description: '最多加载多少屏/页，默认 10' },
        waitMs: { type: 'integer', description: '每次加载后等待的毫秒数，默认 1000' },
        tableIndex: { type: 'integer', description: '只处理第几个表格' },
        scroll: {
          type: 'string',
          enum: ['auto', 'paged', 'scrolled'],
          description: 'auto 默认自动判断；scrolled 强制滚动加载（无限滚动页面）',
        },
        concurrency: { type: 'integer', description: '并发下载数，默认 3' },
        referer: { type: 'string', description: '可选的 Referer 头' },
      },
    },
  },

  {
    name: 'doc.export',
    description:
      '把一段内容保存为文件。format 可选：md（Markdown）、docx（Word）、html、txt。' +
      '当用户要「把网页内容导出成 Word」「保存为文档」时，先用 page.read 取内容再调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要写入文件的正文内容' },
        format: { type: 'string', enum: ['md', 'docx', 'html', 'txt'], description: '默认 md' },
        title: { type: 'string', description: '文件标题，会进入文件名' },
        sourceUrl: { type: 'string', description: '来源页面 URL，用于文件命名' },
      },
      required: ['content'],
    },
  },

  {
    name: 'tab.list',
    description:
      '列出所有已打开的网页标签页（id、标题、URL、是否活动）。' +
      '当用户提到「另一个标签页」「我打开的那些页面」时，先用这个工具拿到 tabId，' +
      '再配合 tab.switch 操作。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tab.open',
    description:
      '打开一个新的标签页访问指定 URL。' +
      '当用户要「打开某个网址」「去看看这个链接」时使用；' +
      '默认会切换到新标签页，可用 active=false 让它在后台打开。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的完整 URL' },
        active: { type: 'boolean', description: '是否切换到新标签页，默认 true' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tab.switch',
    description:
      '切换到指定的标签页并使其获得焦点（tabId 来自 tab.list）。' +
      '当需要操作某个后台标签页时，先切换过去再调用 page.* 工具。',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'integer' } },
      required: ['tabId'],
    },
  },
  {
    name: 'tab.close',
    description:
      '关闭指定的标签页（tabId 来自 tab.list）。' +
      '这是不可逆操作，执行前应先向用户确认要关闭的是哪个页面。',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'integer' } },
      required: ['tabId'],
    },
  },
  {
    name: 'tab.reload',
    description:
      '重新加载当前标签页。当页面内容陈旧、或者刚改过样式需要刷新才能看到效果时使用。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },
  {
    name: 'nav.back',
    description:
      '让当前标签页后退一步（浏览器历史中的上一页）。' +
      '当用户说「返回上一页」「退回去」时使用。',
    parameters: { type: 'object', properties: { tabId: { type: 'integer' } } },
  },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
