const schedule = require('node-schedule');
const co = require('co');
const puppeteer = require('puppeteer');
const config = require('config');

// 解析命令行参数
const argv = require('yargs')
    .options({
        u: {
            alias: [ 'user', 'apple_id' ],
            default: () => {
                return process.env.SCHEDULE_APPLE_ID
            }
        },
        p: {
            alias: [ 'psw', 'password' ],
            default: () => {
                return process.env.SCHEDULE_APPLE_ID_PASSWORD
            }
        }
    })
    .help()
    .argv;

// // 验证参数
// if ( !argv.u ) {
//     throw 'apple id is required'
// }
//
//
// let j = schedule.scheduleJob('*/10 * * * * *', () => {
//     console.log('scheduled job ' + new Date())
// });


const onPageResponse = pageResponseFactory();
co(function* () {
    let browser, teams;

    try {
        // get a chromium instance
        browser = yield puppeteer.launch({ headless: false });
        // get a page instance
        const page = yield browser.newPage();
        page.setViewport({
            width: 1200, height: 768
        });

        onPageResponse(page, [ '/account/getTeams' ], function* (response) {
            teams = yield getTeams.call(this, response);
        }).then(() => {
            return onPageResponse(page, [ 'tpl.overview-view.html' ], function* () {
                yield switchTeam.call(null, page, teams, '76M838UFVQ');
            })
        }).then(() => {
            console.log('执行click')
            return co(function* () {
                const link = '#main .getting-started > a:nth-child(2)';
                // when link is read
                yield page.waitForSelector(link, { timeout: 50000 });
                // navigate to Certificates, Identifiers & Profiles
                yield page.click(link).catch(() => {
                    page.click(link);
                })

                return yield getProfiles.call(this, page);
            })
        }).then(verfityProfiles)
            .then((expires) => {
                console.log('检测到过期profile：' + expires.length)
            })
            .then(() => {
                browser.close();
            })
            .catch((e) => {
                console.log('发生异常：' + e)
                browser.close();
            });

        // 打开苹果开发者中心
        yield page.goto('https://developer.apple.com/account', { timeout: 50000 });

        yield login.call(this, page, 'wangxuebo@gridsum.com', 'wxbo1988X@');

    } catch ( e ) {
        console.log('An error occurred !');
        console.log(e);

        // close the chromium instance
        if ( browser )
            yield browser.close();
    }
});


// 执行登陆操作
function* login(page, user, password) {
    // 当页面渲染完后
    yield page.waitForXPath('//*[@id="submitButton2"]', {
        timeout: 50000
    });

    // 输入用户名
    yield page.focus('#accountname');
    yield page.type('#accountname', user, { delay: 100 });
    // 输入密码
    yield page.focus('#accountpassword');
    yield page.type('#accountpassword', password, { delay: 100 });
    // 点击登陆
    yield page.click('#submitButton2')
}

// 获取开发者加入的Teams信息
function* getTeams(response) {
    let res = yield response.json();
    return res.teams;
}

// 切换Team
function* switchTeam(page, teams, teamid) {
    const executionContext = yield page.mainFrame().executionContext();
    let pageUrl = yield executionContext.evaluate('location.href');

    let isCurrent = pageUrl.indexOf(teamid) > -1;
    let inTeams = teams.some(t => t.teamId === teamid);

    if ( (teams.length === 1 && !isCurrent) || !inTeams ) {
        throw 'Invalid Teamid';
    }

    if ( !isCurrent ) {
        pageUrl = page.url() + '#/overview/' + teamid;

        yield new Promise((resolve, reject) => {
            onPageResponse('load', page, [ 'services-account/checkPermissions' ], function* () {
                console.log('监测到切换Team');
            }).then(resolve).catch(reject);

            // yield executionContext.evaluate(`location.href="${pageUrl}";`);
            executionContext.evaluate(`location.hash="${'#/overview/' + teamid}";location.reload(true)`);
        });
    }
}


function sync(fn, exceptionHandle) {
    return co(function* () {
        yield fn;
    }).then(null, function (e) {
        return co(exceptionHandle.call(this, e))
    })
}

function syncFactory(logger) {
    return function sync(fn, exceptionHandle) {
        co(function* () {
            try {
                yield fn;
            } catch ( e ) {
                if ( typeof exceptionHandle === 'function' ) {
                    exceptionHandle.call(null, e)
                } else {
                    logger.emit('exception', e)
                }
            }
        })
    }
}

// 证书
function* getCertificates(response) {
    let res = yield response.json();
    return res.certRequests;
}

function* verifyCertificates(certs, skipDev) {
    certs = skipDev
        ? certs.filter(cert => cert.certificate.certificateType.distributionType === 'distribution')
        : certs;

    return certs.map(cert => {
        return {
            name: cert.name,
            type: cert.typeString,
            expire: dateDiff(cert.expirationDate)
        }
    })
}

function verfityProfiles(profiles) {
    let confProfiles = config.get('Profiles');
    let ret = profiles.filter(p => {
        let match = confProfiles[ p.name ];
        let diff = dateDiff(new Date(), p.dateExpire);
        if ( !match || diff > (match.alert || config.get('DefaultAlert')) ) {
            return false;
        }

        return {
            name: p.name,
            expire: dateDiff(new Date(), p.dateExpire),
            type: p.type,
            diff
        }
    });
    console.log(ret);
    return ret;
}

// 配置文件
function getProfiles(page) {
    return new Promise((resolve, reject) => {
        onPageResponse(page, [ '/ios/profile/listProvisioningProfiles.action' ], function* (response) {
            let ret = yield response.json();
            return ret.provisioningProfiles;
        }).then(resolve).catch(reject);

        return page.waitForSelector('li.provisioning > ul > li:nth-child(1) > a', {
            timeout: 60000
        }).then((el) => {
            return el.click();
        }).catch(reject)
    });


    return new Promise((resolve, reject) => {
        const onProfilesRequest = function (response) {
            const url = response.url();
            const status = response.status();

            if ( url.indexOf('/ios/profile/listProvisioningProfiles.action') !== -1 ) {
                unRegister();
                response.json().then(ret => ret.provisioningProfiles).catch(unRegister)
            }
        };
        const unRegister = function (e) {
            page.removeListener('response', onProfilesRequest);
        };

        page.on('response', onProfilesRequest);

        page.waitForSelector('li.provisioning > ul > li:nth-child(1) > a').then((el) => {
            return el.click();
        }).catch(unRegister)
    })
}

// 计算两个日期的间隔天数
function dateDiff(today, expirationDate) {
    let delt = new Date(expirationDate).getTime() - new Date(today).getTime();
    return parseInt(delt / 1000 / 60 / 60 / 24);
}

function pageResponseFactory() {
    let _resolve, _reject, _page, _callback, _event;
    _match = function () {
        return false;
    };

    const responseFn = (response) => {
        if ( _event === 'response' ) {
            const url = response.url();
            const hasUrlMatch = _match(url);
            if ( response.ok() && hasUrlMatch ) {
                unRegister();
                co(function* () {
                    return yield _callback.call(this, response)
                }).then(_resolve).catch(_reject);
            }
        } else {
            unRegister();
            co(function* () {
                return yield _callback.call(this, response)
            }).then(_resolve).catch(_reject);
        }

    };
    const unRegister = () => {
        _page.removeListener(_event, responseFn);
    };

    return function onResponse(event, page, urlFilters, callback) {
        return new Promise((resolve, reject) => {
            _resolve = resolve;
            _reject = reject;

            _event = event;
            _callback = callback;
            _page = page;

            if ( callback === undefined ) {
                _event = 'response';
                _callback = urlFilters;
                urlFilters = page;
                _page = event;
            }

            unRegister();
            _match = url => {
                return urlFilters.some(f => url.indexOf(f) > -1);
            };
            _page.on(_event, responseFn)
        });
    }
}

