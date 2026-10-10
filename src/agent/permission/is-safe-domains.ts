const commonDomainsCNForDevelopers = [
  // 搜索 / AI
  "google.com",
  "baidu.com",
  "bing.com",
  "openai.com",
  "claude.ai",
  "anthropic.com",
  "perplexity.ai",
  "kimi.moonshot.cn",
  "doubao.com",
  "deepseek.com",

  // 代码托管 / 开发平台
  "github.com",
  "gitlab.com",
  "gitee.com",
  "bitbucket.org",

  // 技术社区
  "stackoverflow.com",
  "v2ex.com",
  "zhihu.com",
  "juejin.cn",
  "csdn.net",
  "oschina.net",
  "segmentfault.com",
  "infoq.cn",
  "51cto.com",
  "cnblogs.com",
  "linux.do",
  "reddit.com",
  "medium.com",
  "dev.to",
  "hackernoon.com",

  // 文档 / API / 开源
  "npmjs.com",
  "nodejs.org",
  "python.org",
  "pypi.org",
  "rust-lang.org",
  "golang.org",
  "docker.com",
  "kubernetes.io",
  "mozilla.org",
  "developer.mozilla.org",
  "w3.org",
  "react.dev",
  "nextjs.org",
  "vuejs.org",
  "nuxt.com",
  "tailwindcss.com",
  "vercel.com",
  "supabase.com",
  "cloudflare.com",

  // 云服务 / DevOps
  "aliyun.com",
  "tencent.com",
  "huaweicloud.com",
  "aws.amazon.com",
  "azure.com",
  "googleapis.com",
  "firebase.google.com",
  "netlify.com",
  "railway.app",
  "render.com",

  // CI/CD / 工程工具
  "jenkins.io",
  "sonarqube.org",
  "sentry.io",
  "postman.com",
  "swagger.io",
  "openapi.org",

  // 数据库 / 中间件
  "mysql.com",
  "postgresql.org",
  "redis.io",
  "mongodb.com",
  "sqlite.org",
  "apache.org",
  "elastic.co",
  "rabbitmq.com",
  "kafka.apache.org",

  // 办公 / 协作
  "feishu.cn",
  "dingtalk.com",
  "yuque.com",
  "notion.so",
  "atlassian.com",
  "jira.com",
  "confluence.com",
  "slack.com",
  "trello.com",

  // 下载 / 软件
  "jetbrains.com",
  "visualstudio.com",
  "microsoft.com",
  "apple.com",
  "homebrew.sh",
  "iterm2.com",

  // 中国互联网公司
  "qq.com",
  "wechat.com",
  "weibo.com",
  "bilibili.com",
  "douyin.com",
  "xiaohongshu.com",
  "taobao.com",
  "tmall.com",
  "jd.com",
  "aliyun.com",

  // 学习 / 视频
  "youtube.com",
  "coursera.org",
  "udemy.com",
  "leetcode.com",
  "nowcoder.com",
  "geeksforgeeks.org",

  // AI / Agent / 自动化
  "langchain.com",
  "langgraph.dev",
  "huggingface.co",
  "replicate.com",
  "ollama.com",
  "openrouter.ai",
  "tavily.com",
  "smith.langchain.com"
];

/** Match parsed hostnames at DNS label boundaries, including subdomains. */
export function isSafeDomain(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return commonDomainsCNForDevelopers.some((domain) =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}
