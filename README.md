# AI导演大师

让每个人都能用AI拍出电影级视频的在线剪辑工具。

## 功能特点

- 🎬 **可视化分镜编辑器** - 拖拽式分镜设计，景别、运镜、色调一键配置
- ✂️ **专业视频剪辑** - 时间轴剪辑、多轨道编辑、关键帧动画
- 🎤 **AI语音合成** - 支持多种音色、方言，一键生成配音
- 📝 **智能字幕** - 自动生成字幕，支持字幕样式自定义
- 🎥 **高清导出** - 支持4K导出，WebM/MP4格式
- ✨ **AI提示词生成** - 一键生成专业级视频提示词

## 技术栈

- 前端：HTML5 + CSS3 + JavaScript (ES6+)
- 视频处理：WebCodecs API + WebGL
- 导出格式：MP4 (H.264/AAC)、WebM (VP9/Opus)
- TTS：Microsoft Azure Speech Services / Edge TTS

## 快速开始

### 本地开发

```bash
# 方法1：直接打开
浏览器打开 index.html

# 方法2：使用静态服务器
python -m http.server 8080
# 然后访问 http://localhost:8080
```

### 部署上线

1. 上传到 GitHub Pages
2. 或使用 Vercel/Netlify 等平台
3. 无需后端，纯前端部署

## 项目结构

```
ai-director-master/
├── index.html          # 主页面
├── css/
│   └── style.css       # 样式文件
├── js/
│   ├── app.js          # 应用入口
│   ├── editor.js       # 编辑器核心
│   ├── ffmpeg-exporter.js  # FFmpeg导出器
│   ├── video-renderer.js   # 视频渲染器
│   ├── promptEngine.js     # AI提示词引擎
│   ├── tts-manager.js      # TTS语音合成
│   └── core/           # 核心模块
│       ├── VideoEngine.js   # 视频引擎
│       ├── demuxer/         # 解复用器
│       └── renderer/        # 渲染器
└── tts-server/         # TTS服务器（可选）
```

## 使用说明

1. **创建项目** - 点击"新建项目"
2. **导入素材** - 上传视频、图片、音频
3. **编辑时间轴** - 拖拽剪辑素材
4. **添加字幕** - 使用字幕生成功能
5. **生成配音** - 使用TTS功能
6. **导出视频** - 选择分辨率和格式

## 浏览器兼容性

- ✅ Chrome 90+
- ✅ Edge 90+
- ✅ Firefox 90+
- ⚠️ Safari 部分功能受限

## License

MIT
