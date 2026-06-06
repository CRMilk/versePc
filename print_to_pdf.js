const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const files = [
    { html: '程序鉴别材料.html', pdf: '程序鉴别材料.pdf' },
    { html: '文档鉴别材料.html', pdf: '文档鉴别材料.pdf' }
];

async function printToPdf(htmlFile, pdfFile) {
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        const htmlPath = path.join(__dirname, htmlFile);
        win.loadFile(htmlPath);

        win.webContents.on('did-finish-load', async () => {
            try {
                const pdfPath = path.join(__dirname, pdfFile);
                const pdfData = await win.webContents.printToPDF({
                    printBackground: true,
                    pageSize: 'A4',
                    margins: {
                        marginType: 'custom',
                        top: 0.7874,
                        bottom: 0.7874,
                        left: 0.7874,
                        right: 0.7874
                    }
                });
                fs.writeFileSync(pdfPath, pdfData);
                console.log(`✅ ${pdfFile} 已生成`);
                win.close();
                resolve();
            } catch (err) {
                console.error(`❌ 生成 ${pdfFile} 失败:`, err);
                win.close();
                reject(err);
            }
        });
    });
}

app.whenReady().then(async () => {
    for (const file of files) {
        await printToPdf(file.html, file.pdf);
    }
    console.log('\n✅ 所有PDF文件已生成完成！');
    app.quit();
});

app.on('window-all-closed', () => {
    app.quit();
});
