const https = require('https');

const token = 'acf8c497e614ee041d3e5b05f823e4fa';

function request(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'gitee.com',
            path: path,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`状态码: ${res.statusCode}`);
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log('1. 验证令牌，获取用户信息...');
    try {
        const user = await request(`/api/v5/user?access_token=${token}`);
        console.log('用户信息:', JSON.stringify(user, null, 2).slice(0, 500));
    } catch (e) {
        console.log('获取用户信息失败:', e.message);
    }

    console.log('\n2. 获取用户仓库列表...');
    try {
        const repos = await request(`/api/v5/user/repos?access_token=${token}&type=owner`);
        if (Array.isArray(repos)) {
            console.log('仓库列表:');
            repos.forEach(r => console.log(`  - ${r.full_name} (${r.path})`));
        } else {
            console.log('返回:', JSON.stringify(repos).slice(0, 500));
        }
    } catch (e) {
        console.log('获取仓库列表失败:', e.message);
    }
}

main();
