import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import { ethers, network } from "hardhat";
import { utils } from "ethers";
import { ExchangeIssuanceLeveraged } from "@utils/contracts/index";
import { SetFixture } from "@utils/fixtures";
import {
  ICurveAddressProvider,
  ICurvePoolRegistry,
  ICurveRegistryExchange,
  StandardTokenMock,
} from "../../../typechain";
import addresses from "./addresses";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceLeveraged - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setV2Setup: SetFixture;

    let stEth: StandardTokenMock;

    const collateralTokenAddress = addresses.tokens.stEth;
    const collateralATokenAddress = addresses.tokens.stEthAm;
    const debtTokenAddress = addresses.tokens.weth;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      setV2Setup = getSetFixture(owner.address);
      await setV2Setup.initialize();

      stEth = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.stEth,
      )) as StandardTokenMock;
    });

    it("can get lending pool from address provider", async () => {
      let addressProvider = await ethers.getContractAt(
        "ILendingPoolAddressesProviderV2",
        addresses.lending.aave.addressProvider,
      );
      let lendingPool = await addressProvider.getLendingPool();
      expect(lendingPool).to.eq(addresses.lending.aave.lendingPool);
    });

    context("When exchange issuance is deployed", () => {
      let exchangeIssuance: ExchangeIssuanceLeveraged;
      before(async () => {
        exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.set.controller,
          addresses.set.debtIssuanceModuleV2,
          addresses.set.aaveLeverageModule,
          addresses.lending.aave.addressProvider,
          addresses.dexes.curve.addressProvider,
          addresses.dexes.curve.calculator,
        );
      });

      it("weth address is set correctly", async () => {
        expect(await exchangeIssuance.WETH()).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        expect(await exchangeIssuance.sushiRouter()).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        // TODO: Review / Fix misleading name quick vs. uniV2
        expect(await exchangeIssuance.quickRouter()).to.eq(
          utils.getAddress(addresses.dexes.uniV2.router),
        );
      });

      it("uniV3 router address is set correctly", async () => {
        expect(await exchangeIssuance.uniV3Router()).to.eq(
          utils.getAddress(addresses.dexes.uniV3.router),
        );
      });

      it("controller address is set correctly", async () => {
        expect(await exchangeIssuance.setController()).to.eq(
          utils.getAddress(addresses.set.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await exchangeIssuance.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.set.debtIssuanceModuleV2),
        );
      });

      describe("Testing curve contracts", () => {
        let addressProvider: ICurveAddressProvider;
        before(async () => {
          addressProvider = (await ethers.getContractAt(
            "ICurveAddressProvider",
            addresses.dexes.curve.addressProvider,
          )) as ICurveAddressProvider;
        });
        it("curve address provider can provide address of registry", async () => {
          const registryAddress = await addressProvider.get_registry();
          expect(registryAddress).to.eq(utils.getAddress(addresses.dexes.curve.registry));
        });
        describe("testing registry", () => {
          let registry: ICurvePoolRegistry;
          before(async () => {
            registry = (await ethers.getContractAt(
              "ICurvePoolRegistry",
              await addressProvider.get_registry(),
            )) as ICurvePoolRegistry;
          });
          it("should return correct coins", async () => {
            const coins = await registry.get_coins(addresses.dexes.curve.pools.stEthEth);
            expect(coins[0]).to.eq(addresses.dexes.curve.ethAddress);
            expect(coins[1]).to.eq(addresses.tokens.stEth);
          });

          it("should return correct number of coins", async () => {
            const nCoins = await registry.get_n_coins(addresses.dexes.curve.pools.stEthEth);
            expect(nCoins[0]).to.eq(2);
          });
        });
      });

      it("getCoinIndices works", async () => {
        const [i, j] = await exchangeIssuance._getCoinIndices(
          addresses.dexes.curve.pools.stEthEth,
          collateralTokenAddress,
          addresses.dexes.curve.ethAddress,
        );
        expect(i).to.eq(1);
        expect(j).to.eq(0);
      });

      context("When swapping stEth for eth", () => {
        let path: string[];
        let snapshotId: number;

        after(async () => {
          // Currently we have to reset to this snapshot to avoid the second exact output swap from failing with "not enough tokens bought"
          // TODO: Investigate
          await ethers.provider.send("evm_revert", [snapshotId]);
        });
        before(async () => {
          snapshotId = (await network.provider.request({
            method: "evm_snapshot",
            params: [],
          })) as number;


          const addressProvider = (await ethers.getContractAt(
            "ICurveAddressProvider",
            addresses.dexes.curve.addressProvider,
          )) as ICurveAddressProvider;
          const curveRegistryExchange = (await ethers.getContractAt(
            "ICurveRegistryExchange",
            await addressProvider.get_address(2),
          )) as ICurveRegistryExchange;

          const amountIn = ethers.utils.parseEther("5");
          const minAmountOut = amountIn.mul(90).div(100);
          await curveRegistryExchange.exchange(
            addresses.dexes.curve.pools.stEthEth,
            addresses.dexes.curve.ethAddress,
            addresses.tokens.stEth,
            amountIn,
            minAmountOut,
            { value: amountIn },
          );

          path = [collateralTokenAddress, await exchangeIssuance.ETH_ADDRESS()];

          const stEthBalance = await stEth.balanceOf(owner.address);
          await stEth.connect(owner.wallet).transfer(exchangeIssuance.address, stEthBalance);
        });

        it("_swapExactTokensForTokensCurve works", async () => {
          const amountIn = ethers.utils.parseEther("1");
          const minAmountOut = amountIn.mul(90).div(100);

          const ethBalanceBefore = await ethers.provider.getBalance(exchangeIssuance.address);
          await exchangeIssuance._swapExactTokensForTokensCurve(
            path,
            addresses.dexes.curve.pools.stEthEth,
            amountIn,
            minAmountOut,
          );
          const ethBalanceAfter = await ethers.provider.getBalance(exchangeIssuance.address);
          const ethObtained = ethBalanceAfter.sub(ethBalanceBefore);
          console.log("ethObtained:", ethObtained.toString());

          expect(ethObtained.gt(minAmountOut)).to.be.true;
        });

        it("_swapTokensForExactTokensCurve works", async () => {
          const amountOut = ethers.utils.parseEther("1");
          const maxAmountIn = amountOut.mul(110).div(100);

          const ethBalanceBefore = await ethers.provider.getBalance(exchangeIssuance.address);
          await exchangeIssuance._swapTokensForExactTokensCurve(
            path,
            addresses.dexes.curve.pools.stEthEth,
            amountOut,
            maxAmountIn,
          );
          const ethBalanceAfter = await ethers.provider.getBalance(exchangeIssuance.address);
          const ethObtained = ethBalanceAfter.sub(ethBalanceBefore);

          console.log("ethObtained:", ethObtained.toString());

          // TODO: Apparently sometimes the amount is off by one. Investigate why.
          expect(ethObtained.sub(1).lte(amountOut)).to.be.true;
          expect(ethObtained.add(1).gte(amountOut)).to.be.true;
        });
      });

      context("When swapping eth for stEth", () => {
        it("_swapExactTokensForTokensCurve works when", async () => {
          const amountIn = ethers.utils.parseEther("1");
          const minAmountOut = amountIn.mul(90).div(100);

          // Send required amount of eth to the contract to swap
          await owner.wallet.sendTransaction({ to: exchangeIssuance.address, value: amountIn });

          const stEthBalanceBefore = await stEth.balanceOf(exchangeIssuance.address);
          await exchangeIssuance._swapExactTokensForTokensCurve(
            [await exchangeIssuance.ETH_ADDRESS(), collateralTokenAddress],
            addresses.dexes.curve.pools.stEthEth,
            amountIn,
            minAmountOut,
          );
          const stEthBalanceAfter = await stEth.balanceOf(exchangeIssuance.address);

          expect(stEthBalanceAfter.sub(stEthBalanceBefore).gt(minAmountOut)).to.be.true;
        });

        it("_swapTokensForExactTokensCurve works", async () => {
          const amountOut = ethers.utils.parseEther("1");
          const maxAmountIn = amountOut.mul(110).div(100);

          // Send required amount of eth to the contract to swap
          await owner.wallet.sendTransaction({ to: exchangeIssuance.address, value: maxAmountIn });

          const stEthBalanceBefore = await stEth.balanceOf(exchangeIssuance.address);
          await exchangeIssuance._swapTokensForExactTokensCurve(
            [await exchangeIssuance.ETH_ADDRESS(), collateralTokenAddress],
            addresses.dexes.curve.pools.stEthEth,
            amountOut,
            maxAmountIn,
          );
          const stEthBalanceAfter = await stEth.balanceOf(exchangeIssuance.address);
          const stEthObtained = stEthBalanceAfter.sub(stEthBalanceBefore);

          console.log("stEthObtained:", stEthObtained.toString());

          // TODO: Apparently sometimes the amount is off by one. Investigate why.
          expect(stEthObtained.sub(1).lte(amountOut)).to.be.true;
          expect(stEthObtained.add(1).gte(amountOut)).to.be.true;
        });
      });
    });
  });
}