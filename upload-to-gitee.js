/**
 * 一键上传到 Gitee
 * 使用方法: node upload-to-gitee.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
    owner: 'ai-video-editor',      // 你的 Gitee 登录名
    repo: 'ai-video-editor',       // 仓库名
    token: 'acf8c497e614ee041d3e5b05f823e4fa', // 私人令牌
    branch: 'master',              // 分支
    message: '上传网站代码'          // 提交信息
};

// 需要上传的文件（相对于项目根目录）
const UPLOAD_FILES = [
    'index.html',
    'README.md',
    'css/style.css',
    'js/app.js',
    'js/editor.js',
    'js/ffmpeg-exporter.js',
    'js/media-recorder-exporter.js',
    'js/webcodecs-exporter.js',
    'js/video-exporter.js',
    'js/video-renderer.js',
    'js/project-storage.js',
    'js/promptEngine.js',
    'js/text-manager.js',
    'js/tts-manager.js',
    'js/undo-manager.js',
    'js/core/VideoEngine.js',
    'js/core/decoder/FrameBuffer.js',
    'js/core/decoder/VideoDecoderPool.js',
    'js/core/demuxer/MP4Demuxer.js',
    'js/core/demuxer/MP4DemuxerCache.js',
    'js/core/renderer/Compositor.js',
    'js/core/renderer/WebGLRenderer.js',
    'js/libs/lame.min.js',
    'js/libs/mp4-muxer.js',
    'js/libs/mp4box.all.min.js',
    'js/libs/webm-muxer.js',
];

const BASE_PATH = __dirname;

// 编码文件内容为 base64
function encodeBase64(filePath) {
    const content = fs.readFileSync(filePath);
    return content.toString('base64');
}

// 发送 HTTPS 请求
function request(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(result);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${result.message || data}`));
                    }
                } catch (e) {
                    reject(new Error(`解析失败: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

// 上传单个文件
async function uploadFile(filePath, contentBase64, sha = null) {
    const urlPath = encodeURIComponent(filePath);
    const options = {
        hostname: 'gitee.com',
        path: `/api/v5/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${urlPath}`,
        method: sha ? 'PUT' : 'POST',
        headers: {
            'Content-Type': 'application/json;charset=UTF-8'
        }
    };

    const body = {
        access_token: CONFIG.token,
        content: contentBase64,
        message: CONFIG.message,
        branch: CONFIG.branch
    };
    if (sha) body.sha = sha;

    try {
        await request(options, JSON.stringify(body));
        return true;
    } catch (e) {
        // 如果文件已存在，先获取 sha 再更新
        if (e.message.includes('已存在') || e.message.includes('exist')) {
            const getOpts = {
                hostname: 'gitee.com',
                path: `/api/v5/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${urlPath}?ref=${CONFIG.branch}`,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            };
            try {
                const existing = await request(getOpts);
                if (existing && existing.sha) {
                    return uploadFile(filePath, contentBase64, existing.sha);
                }
            } catch (_) {}
        }
        throw e;
    }
}

// 主函数
async function main() {
    console.log('========================================');
    console.log('  Gitee 一键上传工具');
    console.log('========================================');
    console.log(`仓库: ${CONFIG.owner}/${CONFIG.repo}`);
    console.log(`文件数: ${UPLOAD_FILES.length}`);
    console.log('');

    let success = 0;
    let failed = 0;

    for (const filePath of UPLOAD_FILES) {
        const fullPath = path.join(BASE_PATH, filePath);
        
        if (!fs.existsSync(fullPath)) {
            console.log(`⚠️  跳过不存在: ${filePath}`);
            failed++;
            continue;
        }

        try {
            const content = encodeBase64(fullPath);
            await uploadFile(filePath, content);
            console.log(`✅ 上传成功: ${filePath}`);
            success++;
        } catch (e) {
            console.log(`❌ 上传失败: ${filePath}`);
            console.log(`   原因: ${e.message}`);
            failed++;
        }
    }

    console.log('');
    console.log('========================================');
    console.log(`  完成: 成功 ${success} 个, 失败 ${failed} 个`);
    console.log('========================================');
    
    if (success > 0) {
        console.log('');
        console.log('🎉 上传成功！');
        console.log('');
        console.log('下一步：开启 Gitee Pages');
        console.log('1. 打开仓库: https://gitee.com/' + CONFIG.owner + '/' + CONFIG.repo);
        console.log('2. 点击顶部菜单「服务」→「Gitee Pages」');
        console.log('3. 点击「启动」按钮');
        console.log('4. 等待1-2分钟，访问地址: https://' + CONFIG.owner + '.gitee.io/' + CONFIG.repo);
    }
}

main().catch(console.error);
