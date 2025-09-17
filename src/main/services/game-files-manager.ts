import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { spawn } from "node:child_process";
import { app } from "electron";
import type { GameShop } from "@types";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { FILE_EXTENSIONS_TO_EXTRACT } from "@shared";
import { SevenZip } from "./7zip";
import { WindowManager } from "./window-manager";
import { publishInstallationCompleteNotification } from "./notifications";
import { logger } from "./logger";

function getZerokeyConfig() {
    try {
      // Ajusta según dónde quede instalado zerokey/config.yaml
      const configPath = path.join(process.resourcesPath || "", "zerokey", "config.yaml");
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf8");
        return yaml.load(content) as any;
      }
    } catch (err) {
      logger.error("No pude leer zerokey config.yaml", err);
    }
    return null;
  }

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

  private async getExtractionInfo(download: any) {
    const root = download.downloadPath;
    const folderName = download.folderName || "";

    const info: {
      filePath: string | null;
      extractionPath: string | null;
      folderName: string | null;
      compressedFiles?: string[];
    } = {
      filePath: null,
      extractionPath: null,
      folderName: folderName || null,
    };

    try {
      const isCompressed = (fname: string) =>
        FILE_EXTENSIONS_TO_EXTRACT.some((ext) => fname.toLowerCase().endsWith(ext));

      // Leer zerokey/config.yaml
      const zerokeyConfig = getZerokeyConfig();
      const extractedRoot =
        zerokeyConfig?.paths?.extracted_folder || root;

      // 1) Si tenemos folderName, comprobar si es archivo o carpeta
      if (folderName) {
        const candidate = path.join(root, folderName);
        if (fs.existsSync(candidate)) {
          const st = await fs.promises.stat(candidate);
          if (st.isFile() && isCompressed(folderName)) {
            // caso: archivo comprimido suelto en downloadPath
            info.filePath = path.resolve(candidate);
            info.extractionPath = path.join(extractedRoot, path.parse(folderName).name);
            return info;
          } else if (st.isDirectory()) {
            // caso: folderName apunta a un directorio
            const files = await fs.promises.readdir(candidate);
            const compressedFiles = files.filter((f) => isCompressed(f));
            info.compressedFiles = compressedFiles;
            if (compressedFiles.length) {
              // tomamos el primer archivo "extractable" (respeta part1.rar)
              const filesToExtract = compressedFiles.filter(
                (file) => /part1\.rar$/i.test(file) || !/part\d+\.rar$/i.test(file)
              );
              const chosen = filesToExtract.length ? filesToExtract[0] : compressedFiles[0];
              info.filePath = path.resolve(path.join(candidate, chosen));
              // extracción va a extractedRoot/<folderName>
              info.extractionPath = path.join(extractedRoot, folderName);
              return info;
            } else {
              // no hay comprimidos dentro del directorio
              info.filePath = null;
              info.extractionPath = path.join(extractedRoot, folderName);
              return info;
            }
          }
        }
      }

      // 2) Si no hay folderName o no existe, buscar comprimidos directamente en downloadPath
      if (fs.existsSync(root)) {
        const files = await fs.promises.readdir(root);
        const compressedFiles = files.filter((f) => isCompressed(f));
        info.compressedFiles = compressedFiles;
        if (compressedFiles.length) {
          const filesToExtract = compressedFiles.filter(
            (file) => /part1\.rar$/i.test(file) || !/part\d+\.rar$/i.test(file)
          );
          const chosen = filesToExtract.length ? filesToExtract[0] : compressedFiles[0];
          info.filePath = path.resolve(path.join(root, chosen));
          info.extractionPath = path.join(extractedRoot, path.parse(chosen).name);
          return info;
        }
      }

      // fallback: nada encontrado
      return info;
    } catch (err) {
      logger.error("getExtractionInfo failed", err);
      return info;
    }
  }

  async startInstallation(publishNotification = true) {
    const gameKey = levelKeys.game(this.shop, this.objectId);

    const [download, game] = await Promise.all([
      downloadsSublevel.get(gameKey),
      gamesSublevel.get(gameKey),
    ]);

    if (!download || !game) return;

    // Determinar info de extracción lo antes posible
    let extractionInfo: {
      filePath: string | null;
      extractionPath: string | null;
      folderName: string | null;
      compressedFiles?: string[];
    } | null = null;

    try {
      extractionInfo = await this.getExtractionInfo(download);
      logger.log("Determined extractionInfo:", extractionInfo);

      // Guardar extract.json en la misma carpeta que zerokey.exe
      const zerokeyDir = path.join(process.resourcesPath || "", "zerokey");
      const extractFilePath = path.join(zerokeyDir, "extract.json");

      const contents = {
        filePath: extractionInfo.filePath,
        extractionPath: extractionInfo.extractionPath,
        folderName: extractionInfo.folderName,
        compressedFiles: extractionInfo.compressedFiles || [],
        timestamp: new Date().toISOString(),
      };

      try {
        await fs.promises.writeFile(
          extractFilePath,
          JSON.stringify(contents, null, 2),
          "utf8"
        );
        logger.log(`Wrote extract info to ${extractFilePath}`);
      } catch (err) {
        logger.error("Failed to write extract.json", err);
      }
    } catch (err) {
      logger.error("Failed to determine extraction info", err);
    }

    // 1) Marcar extracción como finalizada, e iniciar instalación si existe el binario
    await downloadsSublevel.put(gameKey, {
      ...download,
      extracting: false,
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
      const installerRan = await this.runInstallerIfExists(extractionInfo || undefined);
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

  private async runInstallerIfExists(extractionInfo?: {
    filePath: string | null;
    extractionPath: string | null;
    folderName: string | null;
    compressedFiles?: string[];
  }): Promise<boolean> {
    const candidatePaths = [
      path.join(process.resourcesPath || "", "zerokey", "zerokey.exe"),
      path.join(app.getAppPath() || "", "resources", "zerokey", "zerokey.exe"),
      path.join(__dirname, "..", "resources", "zerokey", "zerokey.exe"),
      path.join(process.resourcesPath || "", "resources", "zerokey", "zerokey.exe"),
    ];

    let installerPath: string | null = null;

    for (const p of candidatePaths) {
      try {
        if (p && fs.existsSync(p)) {
          installerPath = p;
          break;
        }
      } catch {}
    }

    if (!installerPath) {
      logger.log("No zerokey.exe found in resources; skipping installer step.");
      return false;
    }

    return new Promise<boolean>((resolve, reject) => {
      try {
        const installerDir = path.dirname(installerPath);
        const logCandidates = [
          path.join(installerDir, "zerokey.log"),
          path.join(installerDir, "logs", "zerokey.log"),
        ];

        // --- BORRAR ZEROKEY.LOG ANTES DE EJECUTAR ---
        for (const p of logCandidates) {
          try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch {
            // ignorar errores de borrado
          }
        }

        // --- BORRAR extract.json ANTES DE EJECUTAR (y crear uno NUEVO en installerDir) ---
        const extractFilePath = path.join(installerDir, "extract.json");
        try {
          if (fs.existsSync(extractFilePath)) {
            fs.unlinkSync(extractFilePath);
          }
        } catch {
          // ignorar errores de borrado
        }

        // Escribir extract.json (JSON por defecto)
        try {
          const payload = {
            filePath: extractionInfo?.filePath ?? null,
            extractionPath: extractionInfo?.extractionPath ?? null,
            folderName: extractionInfo?.folderName ?? null,
            compressedFiles: extractionInfo?.compressedFiles ?? []
          };
          fs.writeFileSync(extractFilePath, JSON.stringify(payload, null, 2), "utf8");
          logger.log(`Wrote extract info to ${extractFilePath}`);
        } catch (err) {
          logger.error("Failed to write extract.json in installer dir", err);
          // no interrumpimos la instalación por esto
        }

        // Spawn sin stdout/stderr
        const child = spawn(installerPath!, [], { detached: false, stdio: "ignore" });

        let logPath: string | null = null;
        for (const p of logCandidates) {
          if (fs.existsSync(p)) {
            logPath = p;
            break;
          }
        }

        let lastSize = 0;
        let partial = "";
        const POLL_MS = 300;
        let pollInterval: NodeJS.Timeout | null = null;

        const sendLogLine = (line: string) => {
          if (!line) return;
          WindowManager.mainWindow?.webContents.send(
            "on-installation-progress",
            String(this.shop),
            String(this.objectId),
            line.trim()
          );
        };

        const startPolling = () => {
          if (pollInterval) return;
          pollInterval = setInterval(async () => {
            try {
              if (!logPath) {
                for (const p of logCandidates) {
                  if (fs.existsSync(p)) {
                    logPath = p;
                    try {
                      const st = await fs.promises.stat(logPath);
                      lastSize = st.size;
                    } catch {
                      lastSize = 0;
                    }
                    break;
                  }
                }
                return;
              }

              const st = await fs.promises.stat(logPath);
              if (st.size > lastSize) {
                const rs = fs.createReadStream(logPath, {
                  start: lastSize,
                  end: st.size - 1,
                  encoding: "utf8",
                });
                lastSize = st.size;
                rs.on("data", (chunk: string) => {
                  partial += chunk;
                  const lines = partial.split(/\r?\n/);
                  partial = lines.pop() || "";
                  for (const ln of lines) sendLogLine(ln);
                });
              }
            } catch {}
          }, POLL_MS);
        };

        startPolling();

        const cleanup = async (code: number | null) => {
          if (logPath) {
            try {
              const st = await fs.promises.stat(logPath);
              if (st.size > lastSize) {
                const data = await fs.promises.readFile(logPath, "utf8");
                const tail = data.slice(lastSize);
                const combined = partial + tail;
                const lines = combined.split(/\r?\n/).filter(Boolean);
                for (const l of lines) sendLogLine(l);
                partial = "";
              } else if (partial) {
                sendLogLine(partial);
                partial = "";
              }
            } catch {}
          } else if (partial) {
            sendLogLine(partial);
            partial = "";
          }

          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }

          sendLogLine(`Process finished (code ${code})`);

          if (code === 0 || code === null) resolve(true);
          else reject(new Error(`Installer exit code ${code}`));
        };

        child.on("error", (err) => {
          if (pollInterval) clearInterval(pollInterval);
          reject(err);
        });

        child.on("exit", (_code) => setTimeout(() => cleanup(_code), 150));
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
