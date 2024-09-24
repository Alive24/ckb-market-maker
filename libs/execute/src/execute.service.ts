import {
  ExtraCellDepEnum,
  extraCellDepSearchKeys,
} from "@app/commons/utils/cellDeps";
import {
  Action,
  ActionGroupStatus,
  ActionStatus,
  ActionType,
  ScenarioSnapshot,
} from "@app/schemas";
import { ccc, Cell, CellDepLike } from "@ckb-ccc/core";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client, Collector, Pool } from "@utxoswap/swap-sdk-js";
import { EntityManager } from "typeorm";
import { executeSwap, executeTransfer } from "./libs";
import { ActionRepo } from "./repos";

@Injectable()
export class ExecuteService {
  readonly logger = new Logger(ExecuteService.name);
  readonly CKBClient: ccc.Client;
  readonly UTXOSwapClient: Client;
  private readonly collector: Collector;
  private readonly maxPendingTxs: number;
  readonly pathPrefix: string;
  readonly feeRate: number;
  readonly slippage: string;
  private pools: Pool[] = [];
  private scenarioSnapshots: ScenarioSnapshot[] = [];
  symbolToScriptBuffer: {
    [symbol: string]:
      | {
          script: CKBComponents.Script | undefined;
          cellDep: CellDepLike | undefined;
        }
      | undefined;
  } = {};

  constructor(
    configService: ConfigService,
    private readonly entityManager: EntityManager,
    readonly actionRepo: ActionRepo,
  ) {
    const ckbRpcUrl = configService.get<string>("common.ckb_rpc_url");
    const ckbIndexerUrl = configService.get<string>("common.ckb_indexer_url");
    if (ckbIndexerUrl === undefined) {
      throw Error("Empty ckb_indexer_url");
    }
    this.pathPrefix = configService.get<string>("hd_path_prefix") ?? "";
    this.CKBClient = configService.get<boolean>("is_mainnet")
      ? new ccc.ClientPublicMainnet({ url: ckbRpcUrl })
      : new ccc.ClientPublicTestnet({ url: ckbRpcUrl });
    this.collector = new Collector({ ckbIndexerUrl });
    const feeRate = configService.get<number>("fee_rate");
    if (feeRate === undefined) {
      throw Error("Empty fee rate");
    }
    this.feeRate = feeRate;
    const slippage = configService.get<string>("execute.slippage");
    if (slippage === undefined) {
      throw Error("Empty slippage");
    }
    this.slippage = slippage;
    this.actionRepo = actionRepo;
    const UTXOSwapApiKey = configService.get<string>(
      "common.utxo_swap_api_key",
    );
    const isMainnet = configService.get<boolean>("is_mainnet");
    this.UTXOSwapClient = new Client(isMainnet, UTXOSwapApiKey);
  }

  async executeActions(scenarioSnapshot: ScenarioSnapshot): Promise<void> {
    // NOTE: This function is designed to be blocking.
    // TODO: Abort by timer;
    this.logger.verbose("executeActions | Actions in scenarioSnapshot: ");
    for (const [index, action] of scenarioSnapshot.actions.entries()) {
      this.logger.verbose(
        `executeActions | Action #${index} | ${action.actionType} | ${action.actionStatus}`,
      );
    }
    /* Load scripts for tokens */
    for (const action of scenarioSnapshot.actions) {
      for (const target of action.targets) {
        if (
          !Object.keys(this.symbolToScriptBuffer).includes(target.assetXSymbol)
        ) {
          if (target.assetXSymbol === "CKB") {
            this.symbolToScriptBuffer[target.assetXSymbol] = undefined;
          } else {
            // Find the token object among the poolInfos
            const poolInfo = scenarioSnapshot.poolInfos.find(
              (poolInfo) => poolInfo.assetX.symbol === target.assetXSymbol,
            );
            if (!poolInfo) {
              throw new Error(
                `executeActions| Pool info not found for token ${target.assetXSymbol}`,
              );
            } else if (target.assetXSymbol in ExtraCellDepEnum) {
              let extraCellDepCell: Cell;
              while (true) {
                const findCellsResult = await this.CKBClient.findCells(
                  extraCellDepSearchKeys[target.assetXSymbol],
                ).next();
                if (findCellsResult.value) {
                  extraCellDepCell = findCellsResult.value;
                  break;
                }
              }
              const extraCellDepLike: CellDepLike = {
                outPoint: {
                  txHash: extraCellDepCell.outPoint.txHash,
                  index: extraCellDepCell.outPoint.index,
                },
                depType: "code",
              };
              this.symbolToScriptBuffer[target.assetXSymbol] = {
                script: poolInfo.assetX.typeScript,
                cellDep: extraCellDepLike,
              };
            } else {
              this.logger.error(
                `executeActions | Unsupported token ${target.assetXSymbol}`,
              );
            }
          }
        }
      }
    }
    while (
      ![ActionGroupStatus.Aborted, ActionGroupStatus.Completed].includes(
        scenarioSnapshot.actionGroupStatus,
      )
    ) {
      // Wait the interaction interval
      await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
      for (const action of scenarioSnapshot.actions.filter(
        (action) =>
          ![
            ActionStatus.Aborted,
            ActionStatus.Failed,
            ActionStatus.Stored,
          ].includes(action.actionStatus),
      )) {
        // TODO: This is blocking, should be refactored to be non-blocking
        // TODO: Limiting swapping to only one token per action for now. Might implement multiple token swaps in one action in the future.
        let status: ActionStatus;
        switch (action.actionType) {
          case ActionType.Transfer:
            status = await executeTransfer(this, action);
            break;
          case ActionType.Swap:
            const matchingPoolInfo = scenarioSnapshot.poolInfos.find(
              (poolInfo) =>
                poolInfo.assetY.symbol === action.targets[0].assetYSymbol &&
                poolInfo.assetX.symbol === action.targets[0].assetXSymbol,
            );
            // TODO: Reverse the poolInfo if the pool is not found
            if (!matchingPoolInfo) {
              action.actionStatus = ActionStatus.Failed;
              throw new Error("No matching pool found");
            }
            const matchingPool = new Pool({
              tokens: [matchingPoolInfo.assetX, matchingPoolInfo.assetY],
              ckbAddress: action.actorAddress,
              collector: this.collector,
              client: this.UTXOSwapClient,
              poolInfo: matchingPoolInfo,
            });
            const inputValue = Number(action.targets[0].amount) / 10 ** 8;
            const { output } =
              matchingPool.calculateOutputAmountAndPriceImpactWithExactInput(
                inputValue.toString(),
              );
            matchingPool.tokens[0].amount = inputValue.toString();
            matchingPool.tokens[1].amount = output;
            status = await executeSwap(
              this,
              action,
              matchingPool,
              this.slippage,
            );
            break;
          case ActionType.AddLiquidity:
            status = await this.executeAddLiquidity(action);
            break;
          case ActionType.RemoveLiquidity:
            status = await this.executeRemoveLiquidity(action);
            break;
          case ActionType.SwapExactInputForOutput:
            status = await this.executeSwapExactInputForOutput(action);
            break;
          case ActionType.SwapInputForExactOutput:
            status = await this.executeSwapInputForExactOutput(action);
            break;
          case ActionType.ClaimProtocolLiquidity:
            status = await this.executeClaimProtocolLiquidity(action);
            break;
          default:
            throw new Error("Unsupported action type");
        }
        action.actionStatus = status;
      }
      /* Return and finish if all actionStatuses are Stored or any one of them is Aborted */
      if (
        scenarioSnapshot.actions.every(
          (action) => action.actionStatus === ActionStatus.Stored,
        )
      ) {
        scenarioSnapshot.actionGroupStatus = ActionGroupStatus.Completed;
      } else if (
        scenarioSnapshot.actions.some(
          (action) => action.actionStatus === ActionStatus.Aborted,
        )
      ) {
        scenarioSnapshot.actionGroupStatus = ActionGroupStatus.Aborted;
      }
    }
    return;
  }

  private async executeAddLiquidity(action: Action): Promise<ActionStatus> {
    //TODO: implement
    console.log(action);
    return ActionStatus.Confirmed;
  }

  private async executeRemoveLiquidity(action: Action): Promise<ActionStatus> {
    //TODO: implement
    console.log(action);
    return ActionStatus.Confirmed;
  }

  private async executeSwapExactInputForOutput(
    action: Action,
  ): Promise<ActionStatus> {
    // TODO: implement
    console.log(action);
    return ActionStatus.Confirmed;
  }

  private async executeSwapInputForExactOutput(
    action: Action,
  ): Promise<ActionStatus> {
    // TODO: implement
    console.log(action);
    return ActionStatus.Confirmed;
  }

  private async executeClaimProtocolLiquidity(
    action: Action,
  ): Promise<ActionStatus> {
    // TODO: implement
    console.log(action);
    return ActionStatus.Confirmed;
  }
}
