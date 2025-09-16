import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { app } from "electron";
import type { GameShop } from "@types";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { FILE_EXTENSIONS_TO_EXTRACT } from "@shared";
import { SevenZip } from "./7zip";
import { WindowManager } from "./window-manager";
import { publishInstallationCompleteNotification } from "./notifications";
import { logger } from "./logger";


export class GameFilesManager {
  constructor(
    private readonly shop: GameShop,
    private readonly objectId: string
  ) {}

  private async clearExtractionState() {
    const gameKey = levelKeys.game(this.shop, this.objectId);
    const download = await downloadsSublevel.get(gameKey);

    await downloadsSublevel.put(gameKey, {
      ...download!,
      extracting: false,
    });

    WindowManager.mainWindow?.webContents.send(
      "on-extraction-complete",
      this.shop,
      this.objectId
    );
  }

  async extractFilesInDirectory(directoryPath: string) {
    if (!fs.existsSync(directoryPath)) return;
    const files = await fs.promises.readdir(directoryPath);

    const compressedFiles = files.filter((file) =>
      FILE_EXTENSIONS_TO_EXTRACT.some((ext) => file.endsWith(ext))
    );

    const filesToExtract = compressedFiles.filter(
      (file) => /part1\.rar$/i.test(file) || !/part\d+\.rar$/i.test(file)
    );

    await Promise.all(
      filesToExtract.map((file) => {
        return new Promise((resolve, reject) => {
          SevenZip.extractFile(
            {
              filePath: path.join(directoryPath, file),
              cwd: directoryPath,
              passwords: ["online-fix.me", "steamrip.com"],
            },
            () => {
              resolve(true);
            },
            () => {
              reject(new Error(`Failed to extract file: ${file}`));
              this.clearExtractionState();
            }
          );
        });
      })
    );

    compressedFiles.forEach((file) => {
      const extractionPath = path.join(directoryPath, file);

      if (fs.existsSync(extractionPath)) {
        fs.unlink(extractionPath, (err) => {
          if (err) {
            logger.error(`Failed to delete file: ${file}`, err);

            this.clearExtractionState();
          }
        });
      }
    });
  }

  async startInstallation(publishNotification = true) { // <--- RENOMBRADO DE setExtractionComplete
    const gameKey = levelKeys.game(this.shop, this.objectId);

    const [download, game] = await Promise.all([
      downloadsSublevel.get(gameKey),
      gamesSublevel.get(gameKey),
    ]);

    if (!download || !game) return;

    // 1) Marcar extracción como finalizada, e iniciar instalación si existe el binario
    await downloadsSublevel.put(gameKey, {
      ...download,
      extracting: false,
      // ponemos el nuevo estado de instalación solo si existe el instalador
      status: "installing",
    });

    WindowManager.mainWindow?.webContents.send(
      "on-extraction-complete",
      this.shop,
      this.objectId
    );

    WindowManager.mainWindow?.webContents.send(
      "on-installation-start",
      this.shop,
      this.objectId
    );

    // 2) Ejecutar el instalador (zerokey.exe) si existe; esperar a su finalización
    try {
      const installerRan = await this.runInstallerIfExists();
      if (installerRan) {
        // instalación completada correctamente
        await downloadsSublevel.put(gameKey, {
          ...download,
          extracting: false,
          status: "complete",
        });

        WindowManager.mainWindow?.webContents.send(
          "on-installation-complete",
          this.shop,
          this.objectId
        );

        if (publishNotification) {
          publishInstallationCompleteNotification(game!);
        }
      } else {
        // no había instalador: marcar complete (puede ocurrir)
        await downloadsSublevel.put(gameKey, {
          ...download,
          extracting: false,
          status: "complete",
        });

        WindowManager.mainWindow?.webContents.send(
          "on-installation-complete",
          this.shop,
          this.objectId
        );

        if (publishNotification) {
          publishInstallationCompleteNotification(game!);
        }
      }
    } catch (err) {
      logger.error("Installer failed", err);
      // Si la instalación falla: limpiar flags y notificar al renderer
      await downloadsSublevel.put(gameKey, {
        ...download,
        extracting: false,
        status: "error",
      });

      WindowManager.mainWindow?.webContents.send(
        "on-installation-error",
        this.shop,
        this.objectId,
        (err && (err as Error).message) || "Installation failed"
      );
    }
  }


  async setExtractionComplete(publishNotification = true) {
    const gameKey = levelKeys.game(this.shop, this.objectId);

    const [download, game] = await Promise.all([
      downloadsSublevel.get(gameKey),
      gamesSublevel.get(gameKey),
    ]);

    if (!download || !game) return;

    // 1) Marcar extracción como finalizada, e iniciar instalación si existe el binario
    await downloadsSublevel.put(gameKey, {
      ...download,
      extracting: false,
      // ponemos el nuevo estado de instalación solo si existe el instalador
      status: "installing",
    });

    WindowManager.mainWindow?.webContents.send(
      "on-extraction-complete",
      this.shop,
      this.objectId
    );

    WindowManager.mainWindow?.webContents.send(
      "on-installation-start",
      this.shop,
      this.objectId
    );

    // 2) Ejecutar el instalador (zerokey.exe) si existe; esperar a su finalización
    try {
      const installerRan = await this.runInstallerIfExists();
      if (installerRan) {
        // instalación completada correctamente
        await downloadsSublevel.put(gameKey, {
          ...download,
          extracting: false,
          status: "complete",
        });

        WindowManager.mainWindow?.webContents.send(
          "on-installation-complete",
          this.shop,
          this.objectId
        );

        if (publishNotification) {
          publishInstallationCompleteNotification(game!);
        }
      } else {
        // no había instalador: marcar complete (puede ocurrir)
        await downloadsSublevel.put(gameKey, {
          ...download,
          extracting: false,
          status: "complete",
        });

        WindowManager.mainWindow?.webContents.send(
          "on-installation-complete",
          this.shop,
          this.objectId
        );

        if (publishNotification) {
          publishInstallationCompleteNotification(game!);
        }
      }
    } catch (err) {
      logger.error("Installer failed", err);
      // Si la instalación falla: limpiar flags y notificar al renderer
      await downloadsSublevel.put(gameKey, {
        ...download,
        extracting: false,
        status: "error",
      });

      WindowManager.mainWindow?.webContents.send(
        "on-installation-error",
        this.shop,
        this.objectId,
        (err && (err as Error).message) || "Installation failed"
      );
    }
  }

  private async runInstallerIfExists(): Promise<boolean> {
    // 1) Construir posibles rutas del instalador
    // Intentamos: process.resourcesPath/resources/zerokey.exe  (packaged)
    // y también ./resources/zerokey.exe para desarrollo
    const candidatePaths = [
      path.join(process.resourcesPath || "", "zerokey", "zerokey.exe"),
      path.join(app.getAppPath() || "", "resources", "zerokey", "zerokey.exe"),
      path.join(__dirname, "..", "resources", "zerokey", "zerokey.exe"),
    ];

    let installerPath: string | null = null;
    for (const p of candidatePaths) {
      if (p && fs.existsSync(p)) {
        installerPath = p;
        break;
      }
    }

    for (const p of candidatePaths) {
      try {
        const real = fs.realpathSync(p);
        logger.log("Found installer path:", real);
        installerPath = real;
        break;
      } catch {
        logger.log("Not found:", p);
      }
    }


    if (!installerPath) {
      logger.log("No zerokey.exe found in resources; skipping installer step.");
      return false;
    }

    // Ejecutar el .exe y esperar a que termine
    return new Promise<boolean>((resolve, reject) => {
      try {
        const child = spawn(installerPath!, [], {
          detached: false,
          stdio: "ignore",
        });

        child.on("error", (err) => {
          logger.error("Failed to spawn installer", err);
          reject(err);
        });

        child.on("exit", (code, signal) => {
          logger.log(`Installer exited with code ${code} signal ${signal}`);
          if (code === 0 || code === null) {
            resolve(true);
          } else {
            reject(new Error(`Installer exit code ${code}`));
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }


  async extractDownloadedFile() {
    const gameKey = levelKeys.game(this.shop, this.objectId);

    const [download, game] = await Promise.all([
      downloadsSublevel.get(gameKey),
      gamesSublevel.get(gameKey),
    ]);

    if (!download || !game) return false;

    const filePath = path.join(download.downloadPath, download.folderName!);

    const extractionPath = path.join(
      download.downloadPath,
      path.parse(download.folderName!).name
    );

    SevenZip.extractFile(
      {
        filePath,
        outputPath: extractionPath,
        passwords: ["online-fix.me", "steamrip.com"],
      },
      async () => {
        await this.extractFilesInDirectory(extractionPath);

        if (fs.existsSync(extractionPath) && fs.existsSync(filePath)) {
          fs.unlink(filePath, (err) => {
            if (err) {
              logger.error(
                `Failed to delete file: ${download.folderName}`,
                err
              );

              this.clearExtractionState();
            }
          });
        }

        await downloadsSublevel.put(gameKey, {
          ...download!,
          folderName: path.parse(download.folderName!).name,
        });

        this.startInstallation();
      },
      () => {
        this.clearExtractionState();
      }
    );

    return true;
  }
}
